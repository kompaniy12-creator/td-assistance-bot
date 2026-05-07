# td_assistance_bot — biometric photo for PL residence permit

Telegram-бот + WebApp для подготовки фото 35×45 мм под wnioski o pobyt
(zezwolenie na pobyt czasowy/stały/rezydenta UE) согласно
Rozporządzenie MSWiA + e-składanie wniosków от 27.04.2026.

## Архитектура

```
┌──────────────┐    /start      ┌────────────┐
│ Telegram UA  │ ─────────────► │  bot.py    │  RU/UA/PL/EN
│  (клиент)    │ ◄───────────── │ (PTB 21.6) │  /admin_stats
└──────┬───────┘   open WebApp  └──────┬─────┘
       │                               │ web_app_data
       ▼                               │ (gate_failed)
┌──────────────────────┐                │
│ docs/index.html      │                │
│ • камера, валидация  │                │
│ • face-api.js        │                │
│ • кроп 35×45         │                │
│ • similarity (≥0.85) │                │
│ • A4 PDF (jsPDF)     │                │
└──────┬───────────────┘                │
       │ POST /functions/v1/process-photo
       ▼
┌──────────────────────────────────────┐
│ Supabase Edge Function (Deno)        │
│ • retry 2x (1s/3s) + timeout 60s     │
│ • Gemini 2.5 Flash Image             │
│ • bucket originals + processed       │
│ • table photos (для /admin_stats)    │
└──────────────────────────────────────┘
```

## Стек

| Слой | Технология |
|---|---|
| Bot | Python 3.11+, `python-telegram-bot` 21.6, `httpx` |
| WebApp | Vanilla JS, `face-api.js` (tinyFaceDetector + landmark68 + faceRecognitionNet), `jsPDF` |
| Backend | Supabase Edge Function (Deno + TS), Postgres + Storage |
| AI | Google Gemini `gemini-2.5-flash-image` (Nano Banana) |
| Хостинг WebApp | GitHub Pages (`docs/`) или Vercel |

## Структура

```
td_bot/
├── bot.py                   # python-telegram-bot, /start, /help, /admin_stats
├── requirements.txt
├── .env / .env.example
├── docs/
│   └── index.html           # WebApp
├── supabase/
│   ├── functions/
│   │   └── process-photo/
│   │       ├── index.ts     # Gemini wrapper + retry + JSON logs
│   │       └── prompts.ts   # BIOMETRIC_PROMPT_EN (ТЗ §6.1)
│   └── migrations/
│       └── 001_setup.sql    # buckets + photos table
└── vercel.json
```

## Setup

### 1. Локально для разработки бота

```bash
git clone <repo> && cd td_bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Заполнить BOT_TOKEN, WEBAPP_URL и опц. ADMIN_IDS, SUPABASE_SERVICE_ROLE_KEY
python bot.py
```

### 2. Supabase Edge Function

Залить миграции и задеплоить функцию:

```bash
supabase login
supabase link --project-ref bltbuptzsswaislqagwe
supabase db push                                      # создаёт buckets + photos
supabase functions deploy process-photo --no-verify-jwt
```

Секреты функции (один раз):

```bash
supabase secrets set GEMINI_API_KEY=AIzaSy...
supabase secrets set GEMINI_MODEL=gemini-2.5-flash-image
supabase secrets set GEMINI_TIMEOUT_SECONDS=60
```

`SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` Edge Function получает автоматически
через Deno env.

### 3. WebApp (GitHub Pages)

```bash
git add docs/ && git commit -m "deploy webapp" && git push
# Settings → Pages → Source: deploy from branch / main / docs
```

`WEBAPP_URL` в `.env` бота должен указывать на этот URL,
обязательно с busting-параметром `?v=N`, иначе Telegram кэширует
старую версию WebApp агрессивно.

## Конфигурация Edge Function

| Env var | По-умолчанию | Назначение |
|---|---|---|
| `GEMINI_API_KEY` | — (обязателен) | API key из AI Studio (проект на Paid Tier 1) |
| `GEMINI_MODEL` | `gemini-2.5-flash-image` | Какую модель вызывать |
| `GEMINI_TIMEOUT_SECONDS` | `60` | Таймаут одного запроса |
| `SUPABASE_URL` | авто | Для `createClient` |
| `SUPABASE_SERVICE_ROLE_KEY` | авто | Для записи в storage и `photos` |

Retry: 2 попытки с backoff 1s/3s. На статусах 4xx (кроме 429) — без ретрая.

## Конфигурация бота

| Env var | Обязателен | Назначение |
|---|---|---|
| `BOT_TOKEN` | ✅ | От @BotFather |
| `WEBAPP_URL` | ✅ | URL `docs/index.html` (с `?v=N`) |
| `ADMIN_IDS` | для /admin_stats | через запятую: `123,456` |
| `ADMIN_NOTIFICATION_CHAT_ID` | для алёртов | куда слать `gate_failed` |
| `SUPABASE_URL` | для /admin_stats | по умолчанию инфраструктура `bltbup...` |
| `SUPABASE_SERVICE_ROLE_KEY` | для /admin_stats | service-role (НЕ anon) |

## Pipeline (точная последовательность)

1. **Validator** (WebApp, ТЗ §2.2):
   - файл ≤ 20 MB, разрешение ≥ 400×500
   - ровно 1 лицо (`detectAllFaces`)
   - площадь лица ≥ 15% кадра
   - оба EAR ≥ 0.18 (глаза открыты)
   - |roll|, |yaw|, |pitch| ≤ 15°
2. **Crop 35×45** (WebApp, Canvas) → 684×883.
3. **Gemini** (Edge Function): промпт `BIOMETRIC_PROMPT_EN`, retry, timeout.
4. **Identity gate** (WebApp): `faceRecognitionNet` извлекает 128-d дескриптор
   до и после AI, считает cosine similarity. Порог `≥ 0.85`. При провале —
   баннер пользователю + `tg.sendData({event:'gate_failed', ...})` → бот → admin chat.
5. **Iterative JPG compression** (WebApp): q=95→70 шагом 5 до файла ≤ 2.5 MB.
6. **A4 PDF** (jsPDF, по кнопке): сетка 2×2, 5 mm gap, центровано.

## Промпт

`supabase/functions/process-photo/prompts.ts` — английский биометричный промпт
из ТЗ §6.1. Face preservation указан как highest priority. **Не модифицировать
без согласования** с product owner: каждое изменение требует прогона бенчмарка
similarity на эталонном наборе (≥ 95% similarity ≥ 0.85).

## Логи

Edge Function пишет JSON в stdout (Supabase Logs):

```json
{"ts":"2026-05-07T22:10:00Z","event":"gemini_ok","user_id":"123","attempt":0,"latency_ms":11432,"model":"gemini-2.5-flash-image"}
{"ts":"...","event":"request_done","user_id":"123","total_latency_ms":12500,"bytes_in":150000,"bytes_out":380000}
```

События: `request_start`, `upload_original`, `gemini_ok`/`gemini_error`,
`upload_processed`, `request_done`, `request_error`, `config_error`.

Просмотр:

```bash
supabase functions logs process-photo --tail
```

## Troubleshooting

**`429 QUOTA_EXCEEDED` от Gemini** — проект в AI Studio на Free Tier.
Открыть https://aistudio.google.com/apikey, проверить колонку Billing Tier
у ключа. Должно быть `Paid 1`. Если `Free tier · Postpay` — кликнуть по
"Foto bot" (или левое меню → Billing) и проапгрейдить тариф.

**WebApp показывает старую версию** — Telegram кэширует. Поднять
`?v=N` в `WEBAPP_URL` и перезапустить бота.

**`/admin_stats` возвращает ошибку** — проверь `SUPABASE_SERVICE_ROLE_KEY`
в `.env` бота (НЕ anon ключ).

**Similarity всегда `null`** — `faceRecognitionNet` не загрузился, проверь
консоль WebApp на ошибки CDN; модель тяжёлая (~6 MB).

**`gate_failed` не приходит в админ-чат** — `ADMIN_NOTIFICATION_CHAT_ID`
не задан или бот не добавлен в указанный чат с правом писать.

## Roadmap (не входит в текущий MVP)

- Очередь обработок (Redis/RQ) при росте нагрузки
- Панель оператора для ручного апрува низкого similarity
- CRM-интеграция (Bitrix24)
- A/B-тест промпта vs альтернативной модели (Flux Kontext) на similarity
