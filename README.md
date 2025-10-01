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
- **SQLite local**: Tracking de usuarios, mensajes y token de Instagram
- **Single-account design**: Solo un token de Instagram almacenado
- **Persistente**: Datos sobreviven reinicios del contenedor
- **Ventana configurable**: Control de frecuencia de mensajes
- **Token refresh**: Renovación automática cada 24h cuando está próximo a expirar

## 🔒 Seguridad

- **Tokens**: Usar variables de entorno, nunca hardcodear
- **HTTPS**: Obligatorio para webhooks de Meta
- **Firewall**: Solo puertos necesarios abiertos