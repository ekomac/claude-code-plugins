# spotify

Un panel de Spotify que queda al costado del chat de Claude Code, junto a los otros paneles de la sesión.

- Muestra qué está sonando: tema, artista, álbum, dispositivo y una barra de progreso.
- Botones ⏮ anterior, ⏯ play/pausa y ⏭ siguiente (atajos `p`, `k` y `n` con el panel enfocado).
- Selector de playlist: elegís una de tus playlists y empieza a sonar en el dispositivo activo.
- Se dibuja como una tarjeta con borde redondeado gris y usa los colores del tema de la app, así que se ve bien en modo oscuro y en claro.
- `/spotify` vuelve a abrir el panel si lo cerraste.

## Instalación

En una sesión de Claude Code en la terminal:

```
/plugin install spotify --marketplace ekomac/claude-code-plugins
```

Respondé `y` para agregar el marketplace y elegí el alcance (usuario recomendado).

Desde una shell:

```
claude plugin install spotify --marketplace ekomac/claude-code-plugins
```

En la app de escritorio, donde `/plugin` no corre: hacé clic en **+** al lado del cuadro del prompt, después **Plugins**, **Add marketplace** con `ekomac/claude-code-plugins` y luego **Add plugin**.

## Configuración (una sola vez)

Spotify no permite usar su API sin una app propia, así que hace falta un Client ID:

1. Entrá a <https://developer.spotify.com/dashboard> y creá una app.
2. En **Redirect URIs** agregá exactamente `http://127.0.0.1:8888/callback` y marcá **Web API**.
3. Copiá el **Client ID** y pegalo en el panel.
4. Tocá **Conectar con Spotify**, abrí el link y autorizá.
5. El navegador termina en una página que no carga (`http://127.0.0.1:8888/callback?code=…`). Es lo esperado: copiá esa URL completa y pegala en el panel.

Listo: el panel se actualiza solo cada 4 segundos. El login usa PKCE, así que no hace falta ningún client secret. El token de refresco queda guardado en el almacenamiento propio del plugin, dentro de tu configuración de Claude Code; **Desconectar** lo borra.

## Requisitos y límites

- Controlar la reproducción (pasar temas, pausar, cambiar de playlist) requiere **Spotify Premium**; sin Premium el panel igual muestra qué está sonando.
- Tiene que haber un dispositivo activo (Spotify abierto en la compu, el celular, etc.). Si no hay, el panel te lo avisa.
- Mientras la app de Spotify esté en modo desarrollo, solo pueden usarla las cuentas que agregues en **User Management** del dashboard.
