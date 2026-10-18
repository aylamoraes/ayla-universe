# AYLA UNIVERSE

Experiência interativa de exploração espacial. Abra `ayla_universe.html` no navegador (funciona direto do disco, sem servidor).

## Estrutura

```
ayla_universe.html        marcação, abertura em vídeo, navegação, painéis
css/styles.css            sistema visual (tokens, tipografia, componentes, responsivo)
js/catalog.js             dados: corpos celestes, base de conhecimento da AYLA, selos
js/gl.js                  utilitários WebGL2 (matrizes, shaders, malhas)
js/shaders.js             GLSL: planetas procedurais, anéis, atmosfera, estrelas, céu, galáxias
js/universe.js            motor 3D: cenas Explore e Create, câmera, seleção, rótulos
js/fallback.js            mapa orbital 2D, usado só se o WebGL2 não estiver disponível
js/app.js                 interface: abertura, modos, inspetor, Ask AYLA, laboratório, log, ajustes, áudio
assets/video/             ayla-intro.mp4 e .webm (vídeo do Google Flow, otimizado, sem áudio)
assets/img/               ayla-intro-poster.jpg (primeiro quadro, usado como poster e como fallback)
```

## Vídeo de abertura

`<video autoplay muted loop playsinline>` em tela cheia, com `poster`, duas fontes (MP4 e WebM) e um véu escuro para manter o texto legível.
Se o vídeo não carregar ou o navegador bloquear o autoplay, a abertura continua com o quadro estático (com um leve movimento de câmera em CSS).
Com "reduzir movimento" ativo no sistema, ou com economia de dados, o vídeo nem é iniciado.

## Parâmetros de URL (para teste)

- `?q=high|low` força a qualidade gráfica (padrão: `high` no desktop, `low` em telas de toque).
- `?nogl` força o mapa 2D de reserva.
- `?debug` expõe `AYLA_UNIVERSE._S` no console.

## Observações

- A Ask AYLA responde com textos pré-escritos (palavras-chave), não com um modelo de IA ao vivo; a interface diz isso.
- Descobertas e preferências ficam no `localStorage` do navegador (chave `ayla-universe:v2`).
- Fontes (Jost, Cormorant Garamond, IBM Plex Mono) vêm do Google Fonts; sem internet, o navegador usa fontes do sistema.
