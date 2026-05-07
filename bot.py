"""Telegram bot for biometric photo preparation (PL residence permit).

Опен пайплайн идёт в WebApp (docs/index.html). Бот делает только три вещи:
1. Открывает WebApp по /start.
2. Показывает справку по /help.
3. Принимает gate_failed-уведомления через web_app_data, шлёт в админ-чат.
4. /admin_stats — суточная статистика из Supabase для ADMIN_IDS.
"""
import json
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()

BOT_TOKEN  = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL")
ADMIN_IDS  = {int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()}
ADMIN_NOTIFICATION_CHAT_ID = os.getenv("ADMIN_NOTIFICATION_CHAT_ID")  # may be empty
SUPABASE_URL              = os.getenv("SUPABASE_URL", "https://bltbuptzsswaislqagwe.supabase.co")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")  # for /admin_stats

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
log = logging.getLogger(__name__)


# ── i18n ──────────────────────────────────────────────────────
I18N = {
    "ru": {
        "welcome": (
            "👋 Вітаю!\n\n"
            "Я допоможу підготувати фото для документів на дозвіл на проживання в Польщі.\n\n"
            "📋 *Вимоги (з 27.04.2026):*\n"
            "• Формат JPG\n"
            "• Мін. 684×883 px\n"
            "• Макс. 2.5 МБ\n"
            "• Обличчя 70–80% висоти фото\n"
            "• Світлий однотонний фон\n"
            "• Прямий погляд, рот закритий\n\n"
            "Натисніть кнопку нижче, щоб відкрити додаток 👇"
        ),
        "open_btn": "📷 Зробити біометричне фото",
        "help": (
            "ℹ️ *Як користуватися:*\n\n"
            "1. Натисніть /start\n"
            "2. Відкрийте додаток кнопкою\n"
            "3. Завантажте своє фото або зробіть селфі\n"
            "4. Додаток автоматично знайде обличчя, перевірить вимоги та обріже фото\n"
            "5. AI замінить фон на білий і зробить лёгку ретуш (без зміни рис обличчя)\n"
            "6. Скачайте JPG або PDF з 4 фото на A4\n\n"
            "💡 *Поради:*\n"
            "• Світлий або білий фон\n"
            "• Рівне освітлення\n"
            "• Дивіться прямо в камеру\n"
            "• Рот закритий, очі відкриті\n"
            "• Волосся не закриває обличчя"
        ),
        "unknown": "Не розумію цю команду. Введіть /start або /help",
        "admin_only": "Команда доступна тільки адміністраторам.",
        "stats_header": "📊 *Статистика за 24 години*",
        "stats_total": "Оброблено фото: *{n}*",
        "stats_unique_users": "Унікальних користувачів: *{n}*",
        "stats_no_data": "За останні 24 години обробок не було.",
        "stats_error": "Помилка отримання статистики: {err}",
    },
    "uk": None,  # uses ru fallback below
    "pl": {
        "welcome": (
            "👋 Witam!\n\n"
            "Pomogę przygotować zdjęcie do wniosku o pobyt w Polsce.\n\n"
            "📋 *Wymagania (od 27.04.2026):*\n"
            "• Format JPG\n"
            "• Min. 684×883 px\n"
            "• Maks. 2,5 MB\n"
            "• Twarz 70–80% wysokości\n"
            "• Jednolite jasne tło\n"
            "• Wzrok prosto, usta zamknięte\n\n"
            "Naciśnij przycisk, by otworzyć aplikację 👇"
        ),
        "open_btn": "📷 Zrób zdjęcie biometryczne",
        "help": (
            "ℹ️ *Jak używać:*\n\n"
            "1. Naciśnij /start\n"
            "2. Otwórz aplikację przyciskiem\n"
            "3. Zrób selfie lub wybierz zdjęcie z galerii\n"
            "4. Aplikacja sprawdzi wymagania i wykadruje zdjęcie\n"
            "5. AI zastąpi tło białym i wykona lekki retusz\n"
            "6. Pobierz JPG lub PDF z 4 zdjęciami na A4"
        ),
        "unknown": "Nieznana komenda. Wpisz /start lub /help",
        "admin_only": "Komenda tylko dla administratorów.",
        "stats_header": "📊 *Statystyki 24h*",
        "stats_total": "Przetworzonych zdjęć: *{n}*",
        "stats_unique_users": "Unikalnych użytkowników: *{n}*",
        "stats_no_data": "Brak przetworzonych zdjęć w ciągu 24h.",
        "stats_error": "Błąd pobierania statystyk: {err}",
    },
    "en": {
        "welcome": (
            "👋 Hello!\n\n"
            "I'll help you prepare a photo for a Polish residence permit application.\n\n"
            "📋 *Requirements (from 27.04.2026):*\n"
            "• JPG format\n"
            "• Min. 684×883 px\n"
            "• Max. 2.5 MB\n"
            "• Face 70–80% of photo height\n"
            "• Plain light background\n"
            "• Looking straight, mouth closed\n\n"
            "Tap the button below to open the app 👇"
        ),
        "open_btn": "📷 Take biometric photo",
        "help": (
            "ℹ️ *How to use:*\n\n"
            "1. Press /start\n"
            "2. Open the app via the button\n"
            "3. Take a selfie or pick from gallery\n"
            "4. The app validates and crops the photo\n"
            "5. AI replaces the background with white and lightly retouches\n"
            "6. Download JPG or A4 PDF with 4 photos"
        ),
        "unknown": "Unknown command. Type /start or /help",
        "admin_only": "Admin only.",
        "stats_header": "📊 *24h stats*",
        "stats_total": "Processed photos: *{n}*",
        "stats_unique_users": "Unique users: *{n}*",
        "stats_no_data": "No photos processed in the last 24h.",
        "stats_error": "Stats error: {err}",
    },
}


def lang_for(update: Update) -> str:
    code = (update.effective_user.language_code or "").lower() if update.effective_user else ""
    if code.startswith(("ru",)):           return "ru"
    if code.startswith(("uk", "ua")):      return "uk"
    if code.startswith("pl"):              return "pl"
    return "en"


def t(update: Update, key: str, **params) -> str:
    lang = lang_for(update)
    table = I18N.get(lang) or I18N["ru"]            # uk falls back to ru (very close)
    s = table.get(key) or I18N["en"][key]
    return s.format(**params) if params else s


# ── Handlers ─────────────────────────────────────────────────
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[
        InlineKeyboardButton(t(update, "open_btn"), web_app=WebAppInfo(url=WEBAPP_URL))
    ]]
    await update.message.reply_text(
        t(update, "welcome"),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(t(update, "help"), parse_mode="Markdown")


async def web_app_data_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Receive structured events from the WebApp via tg.sendData()."""
    raw = update.message.web_app_data.data if update.message.web_app_data else None
    if not raw:
        return
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("web_app_data: invalid JSON: %r", raw[:200])
        return

    event = payload.get("event")
    log.info("web_app_data: event=%s payload=%s", event, payload)

    if event == "gate_failed" and ADMIN_NOTIFICATION_CHAT_ID:
        user = update.effective_user
        msg = (
            "⚠️ *Quality gate failed*\n\n"
            f"User: `{user.id}` (@{user.username or '-'}, {user.full_name})\n"
            f"Reason: `{payload.get('reason')}`\n"
            f"Score: `{payload.get('score')}`"
        )
        try:
            await context.bot.send_message(
                chat_id=ADMIN_NOTIFICATION_CHAT_ID,
                text=msg,
                parse_mode="Markdown",
            )
        except Exception as e:
            log.exception("Failed to send admin notification: %s", e)


async def admin_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not user or user.id not in ADMIN_IDS:
        await update.message.reply_text(t(update, "admin_only"))
        return

    if not SUPABASE_SERVICE_ROLE_KEY:
        await update.message.reply_text(t(update, "stats_error", err="SUPABASE_SERVICE_ROLE_KEY not set"))
        return

    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    url = f"{SUPABASE_URL}/rest/v1/photos"
    headers = {
        "apikey":        SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }
    params = {
        "select":     "telegram_user_id,created_at",
        "created_at": f"gte.{since}",
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.get(url, headers=headers, params=params)
            res.raise_for_status()
            rows = res.json()
    except Exception as e:
        await update.message.reply_text(t(update, "stats_error", err=str(e)[:200]))
        return

    if not rows:
        await update.message.reply_text(t(update, "stats_no_data"), parse_mode="Markdown")
        return

    total  = len(rows)
    unique = len({r.get("telegram_user_id") for r in rows if r.get("telegram_user_id")})
    msg = "\n".join([
        t(update, "stats_header"),
        "",
        t(update, "stats_total",         n=total),
        t(update, "stats_unique_users",  n=unique),
    ])
    await update.message.reply_text(msg, parse_mode="Markdown")


async def unknown(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(t(update, "unknown"))


def main():
    if not BOT_TOKEN:
        raise ValueError("BOT_TOKEN не знайдено в .env")
    if not WEBAPP_URL:
        raise ValueError("WEBAPP_URL не знайдено в .env")

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("admin_stats", admin_stats))
    app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, web_app_data_handler))
    app.add_handler(MessageHandler(filters.COMMAND, unknown))

    print(f"✅ Бот запущено. WEBAPP_URL: {WEBAPP_URL}; admins: {sorted(ADMIN_IDS) or 'none'}")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
