# portfolioDR

Portafolio personal de Diego Román. Se sincroniza solo con GitHub y Netlify: cuando
cambia un proyecto (lenguaje, descripción, nombre del repo, URL o captura), el
portafolio se actualiza sin tocar el HTML a mano.

## Cómo se mantiene actualizado

La sección de proyectos se alimenta de dos capas, de más completa a más inmediata:

| Capa | Qué aporta | Cada cuánto |
| --- | --- | --- |
| `data/projects.json` | Datos completos: URL en vivo, captura oficial de Netlify, lenguajes, repo, fechas | Cada 3 h vía GitHub Actions |
| API pública de GitHub desde el navegador | Refresca al vuelo lenguaje, URL del repo, descripción y fecha del último push | En cada visita (caché de 30 min) |
| Lista embebida en `index.html` | Respaldo si las dos anteriores fallan | Solo como red de seguridad |

Si el visitante agota el límite de la API de GitHub (60 peticiones por hora e IP
sin token), la página simplemente se queda con los datos de `data/projects.json`.

## Qué se actualiza solo

- **Lenguaje de programación.** Si reescribes un proyecto de JavaScript a
  TypeScript, el chip de color de la tarjeta cambia solo.
- **URL del repositorio.** Si renombras el repo, el botón «código» apunta al
  nombre nuevo. El cruce se hace por el repo que Netlify declara como origen del
  build, así que un rename no rompe el enlace.
- **Vista previa.** Con token de Netlify se usa su captura oficial, que se
  regenera en cada despliegue. Sin token se usa una miniatura de thum.io con
  cache-busting por fecha de push.
- **Descripción, fecha y URL en vivo.**
- **Altas y bajas.** Un sitio nuevo en Netlify aparece solo (con su categoría
  inferida); uno eliminado desaparece.
- **Contadores** de repos y proyectos desplegados en la sección de perfil.

## Archivos

```
data/projects.json          Datos generados. No editar a mano.
data/overrides.json         Curaduría manual. Siempre gana.
scripts/sync-projects.mjs   El sincronizador.
.github/workflows/sync-portfolio.yml   Lo ejecuta cada 3 horas.
```

## Ajustar un proyecto a mano

Todo lo que pongas en `data/overrides.json` tiene prioridad sobre GitHub y
Netlify. La clave es el `id` del proyecto (el subdominio de Netlify):

```json
{
  "hidden": ["portfoliodr"],
  "projects": {
    "grammanual": {
      "name": "Grammanual",
      "desc": "Manual interactivo de gramática en español.",
      "category": "edu",
      "screenshot": "assets/grammanual.jpg"
    }
  }
}
```

Campos disponibles: `name`, `desc`, `category` (`web` o `edu`), `screenshot`,
`url`, `repoName` y `embeddable` (ponlo en `false` si el sitio bloquea el
iframe). Borra un campo para que vuelva a sincronizarse solo. `hidden` excluye
repos o sitios de la grilla.

## Añadir un proyecto que no aparece solo

Sin token de Netlify, un sitio publicado que ningún repositorio declara en su
`homepage` no puede descubrirse solo. Para esos casos basta con declararlo en
`overrides.json` con su `url`: se da de alta como un proyecto más y a partir de
ahí recibe con normalidad su repositorio, lenguaje y fecha cuando se enlace.

```json
{
  "projects": {
    "data-analysta": {
      "url": "https://data-analysta.netlify.app",
      "name": "Data Analysta",
      "desc": "Aplicación de análisis de datos.",
      "category": "web"
    }
  }
}
```

La clave (`data-analysta`) es el subdominio de Netlify. Con
`NETLIFY_AUTH_TOKEN` configurado esto tampoco hace falta: los sitios publicados
se descubren solos.

## Enlazar un proyecto cuyo repo se llama distinto

El sincronizador cruza repositorio y sitio por el nombre, tolerando variantes
como un sufijo numérico (`hostelapp` con `hostelapp1`) o una letra de más
(`dragOn-fire` con `dragonfiree`). Lo que no puede adivinar son los nombres que
cambian de idioma o de concepto. Para esos casos se declara el repo a mano con
`repoName`:

```json
{
  "projects": {
    "surgitaskpro":               { "repoName": "agenda-quirurgica" },
    "pizarra-virtual-matematico": { "repoName": "virtual-board-math" },
    "cvcreatorr":                 { "repoName": "creador_cv_react_vite-" },
    "planner4tendaysit":          { "repoName": "planner10days" }
  }
}
```

Un `repoName` declarado gana sobre cualquier heurística, y a partir de ahí el
proyecto recibe con normalidad su lenguaje, descripción y fecha desde ese
repositorio. El log del workflow lista en cada ejecución qué proyectos quedaron
sin repo y qué repos quedaron sin proyecto, que es de donde salen los pares.

**Con `NETLIFY_AUTH_TOKEN` esto no hace falta:** Netlify sabe exactamente qué
repositorio construye cada sitio, así que el cruce deja de ser una heurística.
Es la forma recomendada de resolverlo.

## Ejecutar la sincronización localmente

```bash
node scripts/sync-projects.mjs --dry-run   # muestra el resultado sin escribir
node scripts/sync-projects.mjs             # regenera data/projects.json
```

Variables opcionales:

- `NETLIFY_AUTH_TOKEN` — activa las capturas oficiales y hace que la lista de
  sitios de Netlify sea la fuente de verdad sobre qué está publicado.
- `GITHUB_TOKEN` — solo sube el límite de peticiones.
- `GITHUB_USER` — por defecto `diegoroman666`.

### Activar las capturas de Netlify

1. Netlify → *User settings* → *Applications* → *New access token*.
2. GitHub → repo → *Settings* → *Secrets and variables* → *Actions* → *New
   repository secret*, con nombre `NETLIFY_AUTH_TOKEN`.

Sin ese secret todo sigue funcionando: se usan miniaturas automáticas y no se da
de baja ningún proyecto.

## Forzar una sincronización inmediata

Desde la pestaña *Actions* del repo, workflow «Sincronizar proyectos» →
*Run workflow*. O por API:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/diegoroman666/portfolioDR/dispatches \
     -d '{"event_type":"sync-projects"}'
```
