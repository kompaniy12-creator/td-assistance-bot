import os
import logging
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
WEBAPP_URL = os.getenv("WEBAPP_URL")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[
        InlineKeyboardButton(
            "📷 Зробити біометричне фото",
            web_app=WebAppInfo(url=WEBAPP_URL)
        )
    ]]
    await update.message.reply_text(
        "👋 Вітаю!\n\n"
        "Я допоможу підготувати фото для документів на дозвіл на проживання в Польщі.\n\n"
        "📋 *Вимоги (з 27.04.2026):*\n"
        "• Формат JPG\n"
        "• Мін. 684×883 px\n"
        "• Макс. 2.5 МБ\n"
        "• Обличчя 70–80% висоти фото\n"
        "• Світлий однотонний фон\n"
        "• Прямий погляд, рот закритий\n\n"
        "Натисніть кнопку нижче, щоб відкрити додаток 👇",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "ℹ️ *Як користуватися:*\n\n"
        "1. Натисніть /start\n"
        "2. Відкрийте додаток кнопкою\n"
        "3. Завантажте своє фото\n"
        "4. Додаток автоматично знайде обличчя та обріже фото\n"
        "5. Перевірте результат та скачайте JPG\n\n"
        "💡 *Поради для якісного фото:*\n"
        "• Світлий або білий фон\n"
        "• Рівне освітлення\n"
        "• Дивіться прямо в камеру\n"
        "• Рот закритий, очі відкриті\n"
        "• Волосся не закриває обличчя",
        parse_mode="Markdown"
    )

async def unknown(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "Не розумію цю команду. Введіть /start або /help"
    )

def main():
    if not BOT_TOKEN:
        raise ValueError("BOT_TOKEN не знайдено в .env")
    if not WEBAPP_URL:
        raise ValueError("WEBAPP_URL не знайдено в .env")

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(MessageHandler(filters.COMMAND, unknown))

    print(f"✅ Бот запущено. WEBAPP_URL: {WEBAPP_URL}")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
