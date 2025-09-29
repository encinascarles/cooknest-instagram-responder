# CookNest Instagram Responder

Servicio automatizado que detecta reels/posts enviados por DM a Instagram y responde automáticamente con mensajes personalizados. Incluye notificaciones por Telegram para mensajes importantes.

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

#### Crear App de Facebook
1. Ve a [Facebook Developers](https://developers.facebook.com/)
2. Crear nueva app → Tipo: "Business"
3. Añadir producto: **Instagram** e **Messenger**

#### Obtener Tokens
1. **Page Access Token**:
   - En Messenger

2. **Verify Token**:
   - Genera una cadena aleatoria (ej: `uuid`)
   - Úsala como token de verificación en Instagram

3. **Instagram Account ID**:
   - Activa LOG_ONLY_WEBHOOKS
   - Manda un mensaje a tu cuenta
   - Copia el recipient id

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
PAGE_ACCESS_TOKEN_1=primera-mitad-del-token
PAGE_ACCESS_TOKEN_2=segunda-mitad-del-token
GRAPH_API_VERSION=v20.0
INSTAGRAM_ACCOUNT_ID=tu-instagram-account-id

# Mensajes
IG_FIRST_TIME_MESSAGE=¡Hola! 👋 Primera vez que nos envías un reel...
IG_RETURNING_MESSAGE=¡Gracias por otro reel! 🙌 Recuerda usar Compartir...
ENABLE_ACK_MESSAGE=true
ACK_MESSAGE=¡Gracias por contactarnos! 😊 Te responderemos pronto.
ACK_WINDOW_DAYS=7

# Telegram (Opcional)
TELEGRAM_BOT_TOKEN=tu-bot-token
TELEGRAM_CHAT_ID=tu-chat-id
NOTIFY_NON_REEL_MESSAGES=true

# Debug
LOG_ONLY_WEBHOOKS=0
```

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
      - PAGE_ACCESS_TOKEN_1=${PAGE_ACCESS_TOKEN_1}
      - PAGE_ACCESS_TOKEN_2=${PAGE_ACCESS_TOKEN_2}
      - GRAPH_API_VERSION=${GRAPH_API_VERSION:-v20.0}
      - INSTAGRAM_ACCOUNT_ID=${INSTAGRAM_ACCOUNT_ID}
      - IG_FIRST_TIME_MESSAGE=${IG_FIRST_TIME_MESSAGE}
      - IG_RETURNING_MESSAGE=${IG_RETURNING_MESSAGE}
      - ENABLE_ACK_MESSAGE=${ENABLE_ACK_MESSAGE:-true}
      - ACK_MESSAGE=${ACK_MESSAGE}
      - ACK_WINDOW_DAYS=${ACK_WINDOW_DAYS:-7}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}
      - NOTIFY_NON_REEL_MESSAGES=${NOTIFY_NON_REEL_MESSAGES:-true}
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

### Detección Automática
- **Reels/Posts**: Detecta URLs de Instagram y adjuntos tipo `ig_reel`, `share`
- **Mensajes de texto**: Respuesta de confirmación configurable
- **Primera vez vs. recurrente**: Mensajes diferentes para nuevos usuarios

### Notificaciones Telegram
- **Solo mensajes importantes**: No spam por reels automáticos
- **Info de usuario**: Nombre completo con enlace a perfil
- **Formato**: `**Nombre Usuario**: mensaje...`

### Base de Datos
- **SQLite local**: Tracking de usuarios y mensajes
- **Persistente**: Datos sobreviven reinicios del contenedor
- **Ventana configurable**: Control de frecuencia de mensajes

## 🔒 Seguridad

- **Tokens**: Usar variables de entorno, nunca hardcodear
- **HTTPS**: Obligatorio para webhooks de Meta
- **Firewall**: Solo puertos necesarios abiertos