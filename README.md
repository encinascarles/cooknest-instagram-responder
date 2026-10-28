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
1. Ráfaga: reels a menos de 2 minutos del anterior. El primero espera 60 s y se decide una sola vez para todos.
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
node scripts/replay-log.js <bot.log> [--out REPLAY.md] [--users-db users.db]
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