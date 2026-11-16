# CookNest Instagram Responder

Servicio que detecta las recetas (reels, posts, enlaces) que la gente envía por error al DM de @cooknest.app en vez de compartirlas con la app, y les enseña a hacerlo bien sin interrumpir conversaciones reales. Incluye notificaciones por Telegram para mensajes importantes.

## 🚀 Despliegue Rápido

```bash
git clone <repo-url>
cd cooknest-instagram-responder
cp .env.example .env
# Configurar .env (ver abajo)
docker-compose up -d
```

## ⚙️ Configuración

### 1. Configuración de Meta/Facebook

#### Crear App de Facebook/Instagram
1. Ve a [Facebook Developers](https://developers.facebook.com/)
2. Crear nueva app → Tipo: "Business"
3. Añadir producto: **Instagram**

#### Obtener Credenciales
1. **App ID y App Secret**:
   - En Settings → Basic de tu app
   - Copia `App ID` e `App Secret`

2. **Verify Token**:
   - Genera una cadena aleatoria (ej: `uuid`)
   - Úsala como token de verificación en Instagram

3. **Instagram Account ID**:
   - Activa LOG_ONLY_WEBHOOKS
   - Manda un mensaje a tu cuenta
   - Copia el recipient id

4. **OAuth Redirect URI**:
   - En Settings → Basic → Add Platform → Website
   - Añade: `https://tu-dominio.com/auth/instagram/callback`

### 2. Configurar Webhook

1. En tu app de Facebook → Instagram
2. **Callback URL**: `https://tu-dominio.com/webhook`
3. **Verify Token**: El mismo que pusiste en `.env`
4. **Eventos**: Suscribirse a `messages`

### 3. Configurar Telegram (Opcional)

#### Crear Bot
1. Habla con [@BotFather](https://t.me/BotFather) en Telegram
2. `/newbot` → Sigue instrucciones
3. Copia el **Bot Token**

#### Obtener Chat ID
1. Usar https://t.me/get_id_bot

### 4. Archivo .env

Copia `.env.example` a `.env` y completa:

```env
# Servidor
PORT=3000

# Meta/Facebook
VERIFY_TOKEN=tu-token-verificacion-aleatorio
INSTAGRAM_ACCOUNT_ID=tu-instagram-account-id

# Instagram OAuth (Business Login)
IG_APP_ID=tu-instagram-app-id
IG_APP_SECRET=tu-instagram-app-secret
IG_REDIRECT_URI=https://tu-dominio.com/auth/instagram/callback
IG_LOGIN_SCOPES=instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish,instagram_business_manage_insights

# Respuestas automáticas
REPLY_MODE=shadow                     # shadow (por defecto) o live
TEST_USER_IDS=123456789,987654321     # en shadow, solo estos IGSID reciben mensajes de verdad
PUBLIC_BASE_URL=https://carlotes.ganxo.net   # URL pública de este servidor (vídeo tutorial)
CREATOR_FOLLOWER_THRESHOLD=5000       # a partir de estos seguidores no se responde (creadores/marcas)

# Telegram (Opcional)
TELEGRAM_BOT_TOKEN=tu-bot-token
TELEGRAM_CHAT_ID=tu-chat-id
NOTIFY_NON_REEL_MESSAGES=true
EXCLUDED_SENTENCES=spam message 1|another spam text|unwanted phrase

# Remy bridge (opcional, ver "Remy bridge")
REMY_BRIDGE_SECRET=                   # vacío: sin reenvío y /internal/remy/* responde 404
REMY_FORWARD_URL=https://remy.perigeu.com/api/public/instagram/17841473716984633
REMY_MEDIA_DIR=                       # opcional, por defecto <tmp>/cooknest-remy-media

# Debug
LOG_ONLY_WEBHOOKS=0
DB_PATH=                              # opcional, por defecto users.db en la raíz
```

### Variables de entorno de las respuestas automáticas

| Variable | Por defecto | Qué hace |
|---|---|---|
| `REPLY_MODE` | `shadow` | `shadow`: el motor decide para todo el mundo y escribe `[shadow] would send <kind> to <id>` en el log, pero solo envía de verdad a `TEST_USER_IDS`. `live`: envía a todo el mundo. |
| `TEST_USER_IDS` | vacío | Lista de IGSID separados por comas que reciben mensajes reales en modo `shadow`. |
| `PUBLIC_BASE_URL` | `https://carlotes.ganxo.net` | URL pública de este contenedor. El vídeo tutorial se envía como `<PUBLIC_BASE_URL>/media/tutorial-instagram-<es|ca|en>.mp4`. |
| `CREATOR_FOLLOWER_THRESHOLD` | `5000` | Con este número de seguidores o más, la persona se trata como creador/marca y no se le responde. |
| `DB_PATH` | `users.db` en la raíz | Ruta de la base de datos SQLite. |

**Eliminadas** (ya no se leen): `IG_FIRST_TIME_MESSAGE`, `IG_RETURNING_MESSAGE`, `ENABLE_ACK_MESSAGE`, `ACK_MESSAGE`, `ACK_WINDOW_DAYS`. Los textos fijos de antes y el ACK automático a los mensajes de texto desaparecen: todos los textos están en `src/messages.js`.

## 🔐 Autenticación OAuth

Después de configurar el `.env`, necesitas autorizar la app con tu cuenta de Instagram:

1. **Inicia el servidor**: `docker-compose up -d` o `npm start`
2. **Abre en el navegador**: `https://tu-dominio.com/auth/instagram/start`
3. **Autoriza la app**: Inicia sesión con tu Instagram Business
4. **Copia el token**: Se mostrará en pantalla y guardará automáticamente en la DB

### Renovación Automática de Tokens

El bot renovará automáticamente el token cada 24 horas si:
- El token tiene al menos 24 horas de antigüedad
- El token expira en menos de 60 días
- El token aún es válido

Los tokens de Instagram expiran cada ~60 días, pero se renuevan automáticamente sin intervención.

## 🐳 Docker Compose

Usando imagen publicada y volúmenes persistentes mínimos (DB y logs):

```yaml
version: '3.8'

services:
  cooknest-instagram-bot:
    image: ghcr.io/encinascarles/cooknest-instagram-responder:latest
    container_name: cooknest-instagram-responder
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=${PORT:-3000}
      - VERIFY_TOKEN=${VERIFY_TOKEN}
      - INSTAGRAM_ACCOUNT_ID=${INSTAGRAM_ACCOUNT_ID}
      - IG_APP_ID=${IG_APP_ID}
      - IG_APP_SECRET=${IG_APP_SECRET}
      - IG_REDIRECT_URI=${IG_REDIRECT_URI}
      - IG_LOGIN_SCOPES=${IG_LOGIN_SCOPES}
      - REPLY_MODE=${REPLY_MODE:-shadow}
      - TEST_USER_IDS=${TEST_USER_IDS}
      - PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-https://carlotes.ganxo.net}
      - CREATOR_FOLLOWER_THRESHOLD=${CREATOR_FOLLOWER_THRESHOLD:-5000}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
      - NOTIFY_NON_REEL_MESSAGES=${NOTIFY_NON_REEL_MESSAGES:-true}
      - EXCLUDED_SENTENCES=${EXCLUDED_SENTENCES}
      - LOG_ONLY_WEBHOOKS=${LOG_ONLY_WEBHOOKS:-0}
    volumes:
      - /home/user/containerdata/cooknestigbot/users.db:/app/users.db
      - /home/user/containerdata/cooknestigbot/logs:/app/logs
```

## 🌐 Proxy

Para usar en producción necesitas un proxy reverso (nginx, traefik, cloudflare tunnel) que:
- Maneje SSL/HTTPS (requerido por Meta)
- Redirija el tráfico al puerto 3000
- Configure el dominio público para el webhook

## 🔧 Funcionalidades

### Respuestas automáticas a recetas

Mucha gente comparte un reel de receta con nuestro DM en vez de con la app (Compartir → Compartir en... → CookNest). El bot les enseña el gesto, sin repetirse y sin meterse en conversaciones.

**Qué cuenta como receta:** reels/posts compartidos de forma nativa (adjuntos `ig_reel`, `reel`, `ig_post`, `share`; `story`/`ig_story`/`template` solo si llevan contenido compartido), enlaces `instagram.com/reel|reels|p/` (con un comentario corto, máx. 40 caracteres) y vídeos de TikTok o YouTube Shorts solo si el mensaje es únicamente el enlace. Cualquier otro texto o enlace no tiene respuesta automática (se avisa por Telegram como siempre).

**Cuándo calla** (y avisa por Telegram), en este orden:
1. Ráfaga: reels a menos de 2 minutos del anterior. El primero se contesta al instante; los siguientes de la ráfaga quedan en silencio.
2. Un humano del equipo le ha escrito en los últimos 14 días. Se detecta por los ecos: el bot guarda el `message_id` de todo lo que envía, y un eco con otro `mid` es de un humano.
3. Ha escrito texto libre (no reels, no botones) en las últimas 24 h y nadie le ha contestado.
4. Le seguimos, es una cuenta verificada o tiene `CREATOR_FOLLOWER_THRESHOLD` seguidores o más (User Profile API, en caché 24 h). Si el perfil no se puede consultar: silencio para enlaces, flujo normal para reels compartidos.
5. Ya le respondimos hace menos de 1 hora.

**Escalado por persona:**
- Nivel 1 (primera vez, también para usuarios antiguos): vídeo tutorial + mensaje corto con su nombre si parece un nombre real + 3 botones (quick replies): «Ya me sale ✅», «No me sale CookNest», «No tengo la app».
- Nivel 2 (siguiente reel en menos de 30 días): una línea, rotando variantes.
- Nivel 3 y más: silencio. Telegram, una vez por semana como máximo: «<nombre> (@usuario) te ha enviado N reels esta semana, escríbele tú».
- Tras 30 días sin reels, el siguiente vuelve al nivel 2.

**Botones:** «Ya me sale» → una línea alegre. «No me sale CookNest» → dónde se esconde el icono + `https://cooknest.app/tutorial`, y aviso a Telegram. «No tengo la app» → qué hace CookNest + `https://cooknest.app`.

**Idiomas:** castellano, catalán e inglés, según el texto que la persona nos haya escrito (librería `eld`); castellano si no ha escrito nada.

**Código:** `src/engine.js` tiene la decisión como función pura `decide(state, event, now) -> action`; `src/responder.js` reúne el estado, espera las ráfagas, llama a `decide()` y ejecuta la acción. Todos los textos están en `src/messages.js`. Los vídeos están en `public/media/tutorial-instagram-<es|ca|en>.mp4` (generados con los clips del tutorial de Instagram de la app) (servido por Express desde `public/`).

### Pruebas y herramientas

```bash
npm test                                             # node:test, casos sacados del log real
node scripts/replay-log.js <bot.log> [--out REPLAY.md] [--users-db users.db] [--forward] [--decisions decisions.jsonl]
                                                     # repasa el log de producción con el motor nuevo, no envía nada
node scripts/export-messages.js MESSAGES.md          # todos los textos en una lista para revisar
```

### Notificaciones Telegram
- **Mensajes importantes**: Notifica cuando usuarios envían mensajes (no reels)
- **Info de usuario**: Nombre completo con enlace a perfil de Instagram
- **Alertas de errores**: Notificación automática si hay problemas críticos:
  - 🔐 Token expirado o inválido
  - 🔄 Fallo en renovación automática de token
  - 💬 Error al enviar mensajes
  - 🌐 Errores de API de Instagram
- **Formato compacto**: `**Nombre Usuario**: mensaje...`

### Base de Datos
- **SQLite local**: Tracking de usuarios, mensajes y token de Instagram. Las migraciones solo añaden tablas y columnas (`reply_state`, `bot_messages`, `recipe_events`), así que un `users.db` existente sigue funcionando
- **Single-account design**: Solo un token de Instagram almacenado
- **Persistente**: Datos sobreviven reinicios del contenedor
- **Token refresh**: Renovación automática cada 24h cuando está próximo a expirar

## Remy bridge

Remy (the CRM) shows the @cooknest.app DMs. Meta has one webhook URL, so this responder stays the front door: it keeps answering exactly as before and hands every Instagram messaging event to Remy. It also owns the token: Remy sends and reads through it. Code: `src/remy-bridge.js` (outbox), `src/remy-routes.js` (endpoints), `src/remy-media.js` (temporary files), `src/remy-signature.js`.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `REMY_BRIDGE_SECRET` | empty | Shared HMAC secret. Empty: the bridge is off (nothing is forwarded, every `/internal/remy/*` and `/internal-media/*` answers 404). |
| `REMY_FORWARD_URL` | empty | Full URL events are posted to, e.g. `https://remy.perigeu.com/api/public/instagram/17841473716984633`. Empty: nothing is forwarded (the endpoints still work if the secret is set). |
| `REMY_MEDIA_DIR` | `<tmp>/cooknest-remy-media` | Where files sent from Remy wait for Graph (1 h). Emptied at startup. |
| `INSTAGRAM_ACCOUNT_ID` | | Business IG user id (`17841473716984633`): the `account` of every POST, and the sender of `/internal/remy/send`. |
| `PUBLIC_BASE_URL` | `https://carlotes.ganxo.net` | Base of the file URLs Graph downloads (`<PUBLIC_BASE_URL>/internal-media/<name>`). |

### Signature (both directions)

Every request carries `X-Bridge-Timestamp: <unix seconds>` and `X-Bridge-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>` (a GET signs an empty body). More than 300 s of skew, a bad or missing signature: 401. Compared in constant time.

### Responder -> Remy: `POST <REMY_FORWARD_URL>`

```json
{ "account": "17841473716984633", "sentAt": "<iso>",
  "events": [ { "id": "<stable id>", "event": { "...": "entry.messaging[] exactly as Meta sent it" },
                "origin": "user | bot | human | remy",
                "bot": { "classified": "recipe|text|quick_reply|other", "decision": "reply|silent|error", "kind": "...", "reason": "..." },
                "profile": { "igsid", "username", "name", "followerCount", "isVerifiedUser",
                             "isUserFollowBusiness", "isBusinessFollowUser", "profilePic" } } ] }
```

- **Every** messaging event goes: messages (text, shares, attachments, story replies and mentions, quick replies), echoes, reactions, reads/seen, edits, unsends and `is_unsupported` ones. The bot still ignores the last ones; only Remy gets them.
- **Ids** (Remy dedupes by them):

  | Event | `id` |
  |---|---|
  | message, echo, `is_unsupported` message | `<mid>` |
  | unsend (`message.is_deleted`) | `deleted:<mid>` |
  | `message_edit` | `edit:<mid>:<timestamp>` |
  | `reaction` (react/unreact) | `reaction:<mid>:<action>:<timestamp>` |
  | `read` / `messaging_seen` | `read:<mid or watermark>:<timestamp>` |
  | anything else (postback, referral...) | `<first key besides sender/recipient/timestamp>:<sha1 of the event's JSON>` |

  `<timestamp>` is the event's `timestamp` as Meta sent it (epoch ms).
- **origin**: an inbound message from the person is `user`. A message from our account is `bot` when its mid is in `bot_messages`, `remy` when it is in `remy_messages`, else `human` (typed on the phone); in-flight sends (the bot's and Remy's) are awaited first, so an echo that beats Graph's send answer is still labelled right. Reads, reactions and edits are `user` from the person and `human` from our account.
- **bot**: only on inbound messages, sent once the bot has decided. `classified` is `detect.js`'s class; `decision` is `reply` when the engine chose to reply, otherwise `silent` (`kind` and `reason` are the engine's, e.g. `level1`, `burst`, `free_text`). All the reels of one wait group carry the group's decision; a reel silenced by the burst rule carries `silent` + `burst`. If the bot's handling throws: `error`, with the error message as `reason`. With `REPLY_MODE=shadow`, `reply` means the engine's choice even when only logged.
- **profile**: on inbound messages, the profile the decision used, else the 24 h cache or a fetch (`null` when it fails); on other events, the cached profile or `null`.
- **Order**: events are posted in the order they become ready: an inbound message after its decision, an echo once its origin is known. Sort by `event.timestamp`.

### Outbox

Forwarding never makes the bot wait and can never throw into it: each event is appended to `remy_outbox` in `users.db` (`event_id` unique, `payload`, `attempts`, `next_at`, `last_error`, `created_at`) and a background sender posts it.

- Up to 50 events per POST, oldest first. Remy answers 2xx = delivered (the rows are deleted); anything else or a network error = retry the same batch after 10 s, doubling up to 30 min. Events queued meanwhile wait behind it.
- An event still undelivered 48 h after it was queued is dropped, with **one** Telegram line per outage (`⚠️ Remy bridge: N Instagram events could not be delivered...`). The next successful POST ends the outage.
- At least once: a crash between Remy's 2xx and the delete resends the batch; a Meta webhook retry may resend an event. Remy dedupes by `id`.
- Remy down = the outbox grows; Remy back = it drains in order. The outbox survives restarts.

### Remy -> responder: `/internal/remy/*`

Over the LAN (`http://192.168.5.3:3000`), signed as above. A request with `cf-connecting-ip` or `cf-ray` (it came through the public Cloudflare host) gets 403 even when signed. Errors are `{ "error": { "status", "message" } }`.

| Endpoint | Answer |
|---|---|
| `POST /internal/remy/send` `{ recipientId, text?, file?: { filename, contentType, dataBase64 }, replyToMid?, idempotencyKey }` | `{ messageIds: [...] }`, or Graph's error verbatim with Graph's status: `{ error: { status, code, subcode, message } }` (outside the 24 h window: 400, code 10, subcode 2534022). Never sent with a tag. |
| `GET /internal/remy/profile/:igsid` | `{ igsid, username, name, followerCount, isVerifiedUser, isUserFollowBusiness, isBusinessFollowUser, profilePic }` (24 h cache, shared with the bot). |
| `GET /internal/remy/conversations?after=<cursor>` | `{ data: [{ id, updatedTime, participants: [{ id, username }] }], next }` (`me/conversations?platform=instagram`, 50 per page; `next` is Graph's `after` cursor when there is a next page, else `null`). |
| `GET /internal/remy/conversations/:id/messages?after=<cursor>` | `{ data: [<Graph message>], next }` (`<id>/messages?fields=id,message,created_time,from,to,attachments,shares,story,reactions,is_unsupported`, 50 per page). Graph's objects as they come, minus the nested `paging` links (they carry the access token). |
| `GET /internal/remy/health` | `{ ok, tokenExpiresAt, igUserId, username, forward: { queued, oldestAt, lastOkAt, lastError } }` |

**send** details:
- Text first, then the file as its own message when both come; `replyToMid` becomes Graph's `reply_to: { mid }` on the first one.
- Each resulting mid is stored in `remy_messages` before answering, and the send is registered as in flight for that person, so a concurrent echo waits for it and comes out as `remy`. The first sent message also sets `lastHumanAt = now` (the same update an echo typed on the phone makes), so the bot never talks over a conversation held from Remy.
- Files: `image/jpeg|png|gif|webp` up to 8 MB -> `image`; `video/mp4|video/quicktime` up to 25 MB -> `video`; `audio/*` up to 25 MB -> `audio`; anything else, empty, too big or bad base64: 422 with the reason. The file is written to `REMY_MEDIA_DIR` and served, public and unsigned (Graph only takes attachments by URL), at `<PUBLIC_BASE_URL>/internal-media/<64 random hex chars>.<ext>` for 1 hour, then deleted (timer + sweep every 10 min); after that, 404.
- Same `idempotencyKey` again (within 24 h, stored in `remy_idempotency`), or a concurrent duplicate: the first answer again, never a second send. That includes an error answer: retry with a new key.
- Text sent but the file failed: Graph's error, plus `messageIds` with what did go.

**Reading health**:
- `ok`: there is a token and it has not expired. `false` means Remy can neither send nor read: re-authorize at `/auth/instagram/start`.
- `tokenExpiresAt`: when the stored token expires (ISO; the daily token refresh keeps pushing it forward).
- `igUserId`, `username`: the business account (`username` comes from Graph `me`, cached 1 h; `null` if Graph does not answer).
- `forward.queued` and `forward.oldestAt`: events waiting in the outbox and when the oldest was queued. A few for a few seconds is normal; a growing number with an old `oldestAt` means Remy is not taking them (drop after 48 h).
- `forward.lastOkAt`: last delivered POST since this process started (`null` after a restart until the next one). `forward.lastError`: the last failure (`HTTP 503`, `ECONNREFUSED`...), `null` once delivered; `forwarding is off: REMY_FORWARD_URL is not set` when it is off.

### Replay proof

`scripts/replay-log.js --forward` (or `REPLAY_FORWARD=1`) runs the same replay with every event also going through the real outbox to a fake in-memory Remy that checks each signature; `--decisions <file>` writes every decision as a JSON line. Run on the production log of 16-nov-2026 (a copy outside this repo):

```bash
D=~/workspace/ig-responder/data
node scripts/replay-log.js $D/bot-tail-20261116.log --users-db $D/users-20261116.db --out /tmp/off.md --decisions /tmp/off.jsonl
node scripts/replay-log.js $D/bot-tail-20261116.log --users-db $D/users-20261116.db --out /tmp/on.md  --decisions /tmp/on.jsonl --forward
cmp /tmp/off.jsonl /tmp/on.jsonl   # no output: identical
```

Result: 2646 decisions both ways, byte for byte identical (461 replies = 771 Instagram messages, 528 + 134 + 195 Telegram lines, the same report as on `main`). With `--forward`: 2971 events reached the fake Remy (2646 `user`, 325 `human`), 2971 distinct ids, 2861 POSTs, 0 bad signatures, outbox empty at the end; inbound by decision: `recipe/reply` 461, `recipe/silent` 1657, `text/silent` 358, `other/silent` 170. `test/replay.test.js` checks the same on a small synthetic log.

## 🔒 Seguridad

- **Tokens**: Usar variables de entorno, nunca hardcodear
- **HTTPS**: Obligatorio para webhooks de Meta
- **Firewall**: Solo puertos necesarios abiertos

## 🚨 Monitoreo y Alertas

El bot está diseñado para ser completamente autónomo. Sin embargo, recibirás notificaciones de Telegram cuando:

### Notificaciones Automáticas

**Al Iniciar el Bot:**
- ✅ Confirmación de inicio con token válido
- ⚠️ Alerta si falta autorización (con link directo para OAuth)

**Errores Críticos:**
- **Token Expirado**: Si el token de Instagram expira sin poder renovarse
- **Fallo en Renovación**: Si el proceso automático de renovación falla
- **Error al Enviar**: Si no se puede enviar un mensaje a un usuario
- **Errores de API**: Problemas con las APIs de Instagram/Facebook

### Formato de Alertas
Cada alerta incluye:
- Emoji identificativo del tipo de error
- Descripción clara del problema
- Detalles técnicos (si aplica)
- Timestamp de cuando ocurrió
- Acción recomendada (si aplica)

**Ejemplo:**
```
🔐 Token Expired

⚠️ Instagram access token has expired!

ℹ️ Please re-authorize the app by visiting /auth/instagram/start

🕐 2025-10-01 15:42:13
```

Con este sistema, solo recibes notificaciones cuando realmente necesitas actuar.