## CookNest Instagram Responder

Servicio mínimo en Node.js que detecta Reels/posts enviados por DM a la cuenta de Instagram y responde automáticamente con un mensaje predefinido.

### Requisitos

- Node.js 18+
- Cuenta de Facebook/Meta con página conectada a Instagram y permisos de Mensajería de Instagram

### Configuración

1. Copia `.env.example` a `.env` y completa:

```
PORT=3000
VERIFY_TOKEN=<token-de-verificacion-para-webhook>
PAGE_ACCESS_TOKEN=<page-access-token-de-Meta>
GRAPH_API_VERSION=v21.0
IG_REPLY_MESSAGE="Tu mensaje personalizado"
```

2. Instala dependencias:

```
npm install
```

3. Arranca el servidor:

```
npm run dev
```

4. Expone el puerto públicamente (ngrok, cloudflared) y configura el Webhook en el panel de Meta para el producto Instagram con:

- Verify Token: el mismo `VERIFY_TOKEN`
- Callback URL: `https://<tu-domino>/webhook`
- Suscripciones: mensajes (IG) / messaging

### Comportamiento

- El endpoint `GET /webhook` valida el token de verificación.
- El endpoint `POST /webhook` procesa eventos. Si detecta un Reel/post (enlace `instagram.com/reel/...` o `instagram.com/p/...` o adjunto nativo), envía una respuesta automática con `IG_REPLY_MESSAGE`.
- Para otros mensajes, no responde.

### Detección de Reel/post

- Texto: regex de URLs `instagram.com/reel/...` o `instagram.com/p/...`.
- Adjuntos: tipos `reel`, `story`, `share`, `template` con payload que contenga link de Instagram.

### Notas

- Este bot no maneja flujos de atención; sólo auto-responde en el caso específico.
- Asegúrate de que la app tiene permisos y que el Instagram está vinculado a la página de Facebook correspondiente.
