#!/usr/bin/env node
/**
 * Sincroniza data/projects.json con GitHub y Netlify.
 *
 * Fuentes:
 *   - GitHub  : nombre del repo, descripción, URL del repo, lenguaje principal,
 *               desglose de lenguajes, topics, homepage y fecha del último push.
 *   - Netlify : sitios publicados, URL en vivo, screenshot oficial y el repo
 *               conectado a cada sitio (el mejor identificador para cruzar ambos).
 *
 * Reglas de fusión:
 *   1. data/overrides.json siempre gana (curaduría manual).
 *   2. Un dato vacío nunca pisa a uno que ya existía: solo se enriquece o se
 *      reemplaza con información nueva y no vacía.
 *   3. Netlify manda sobre qué está publicado; si no hay token de Netlify, la
 *      lista actual se conserva y solo se refrescan los datos de GitHub.
 *
 * Variables de entorno:
 *   GITHUB_USER         usuario de GitHub            (por defecto: diegoroman666)
 *   GITHUB_TOKEN        token de GitHub              (opcional, sube el rate limit)
 *   NETLIFY_AUTH_TOKEN  token personal de Netlify    (opcional, activa screenshots)
 *
 * Uso:
 *   node scripts/sync-projects.mjs
 *   node scripts/sync-projects.mjs --dry-run    imprime el resultado sin escribir
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUTA_PROYECTOS = resolve(RAIZ, 'data/projects.json');
const RUTA_OVERRIDES = resolve(RAIZ, 'data/overrides.json');

const USUARIO = process.env.GITHUB_USER || 'diegoroman666';
const TOKEN_GITHUB = process.env.GITHUB_TOKEN || '';
const TOKEN_NETLIFY = process.env.NETLIFY_AUTH_TOKEN || '';
const DRY_RUN = process.argv.includes('--dry-run');

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Palabras que delatan un proyecto educativo cuando no hay topic explícito.
const PISTAS_EDU = [
  'edu', 'educacion', 'educación', 'education', 'learning', 'escolar', 'school',
  'curso', 'course', 'matematica', 'matemática', 'math', 'paes', 'estudio',
  'aprendizaje', 'tutorial', 'quiz', 'gramatica', 'gramática', 'profesor',
  'estudiante', 'academico', 'académico', 'pizarra', 'diccionario', 'probabilidad',
  'estadistica', 'estadística'
];

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------

function log(...args) {
  console.log('[sync]', ...args);
}

/** Convierte cualquier fecha que devuelvan las APIs a ISO, o null si no sirve. */
function aISO(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fechaLegible(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dia = String(d.getUTCDate()).padStart(2, '0');
  return `${dia} ${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Normaliza un nombre para poder comparar repos con subdominios de Netlify. */
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');
}

/** "mi-proyecto_genial" -> "Mi Proyecto Genial" */
function titular(slug) {
  return String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Primer segmento del host: "mi-app.netlify.app" -> "mi-app" */
function subdominio(url) {
  const h = host(url);
  return h.endsWith('.netlify.app') ? h.slice(0, -'.netlify.app'.length) : '';
}

function noVacio(valor) {
  if (valor == null) return false;
  if (typeof valor === 'string') return valor.trim() !== '';
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
}

/** Asigna `valor` en `destino[clave]` solo si aporta información. */
function enriquecer(destino, clave, valor) {
  if (noVacio(valor)) destino[clave] = valor;
}

async function pedirJSON(url, cabeceras, { tolerarFallo = false } = {}) {
  const res = await fetch(url, { headers: cabeceras });
  if (!res.ok) {
    const detalle = `${res.status} ${res.statusText} — ${url}`;
    if (tolerarFallo) {
      log('aviso: no se pudo leer', detalle);
      return null;
    }
    throw new Error(detalle);
  }
  return res.json();
}

/** Recorre todas las páginas de un endpoint paginado. */
async function pedirTodo(urlBase, cabeceras) {
  const items = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const sep = urlBase.includes('?') ? '&' : '?';
    const lote = await pedirJSON(`${urlBase}${sep}per_page=100&page=${pagina}`, cabeceras);
    if (!Array.isArray(lote) || lote.length === 0) break;
    items.push(...lote);
    if (lote.length < 100) break;
  }
  return items;
}

// ----------------------------------------------------------------------------
// GitHub
// ----------------------------------------------------------------------------

const CABECERAS_GITHUB = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'portfolioDR-sync',
  ...(TOKEN_GITHUB ? { Authorization: `Bearer ${TOKEN_GITHUB}` } : {})
};

async function leerGitHub() {
  log(`consultando repositorios de ${USUARIO}...`);
  const repos = await pedirTodo(
    `https://api.github.com/users/${USUARIO}/repos?sort=pushed`,
    CABECERAS_GITHUB
  );

  const utiles = repos.filter(r => !r.fork && !r.private);
  log(`${repos.length} repos (${utiles.length} propios y públicos)`);

  // El desglose de lenguajes es una llamada por repo.
  await Promise.all(
    utiles.map(async repo => {
      const datos = await pedirJSON(repo.languages_url, CABECERAS_GITHUB, { tolerarFallo: true });
      repo._languages = datos
        ? Object.entries(datos).sort((a, b) => b[1] - a[1]).map(([nombre]) => nombre)
        : (repo.language ? [repo.language] : []);
    })
  );

  return { repos, utiles };
}

// ----------------------------------------------------------------------------
// Netlify
// ----------------------------------------------------------------------------

async function leerNetlify() {
  if (!TOKEN_NETLIFY) {
    log('sin NETLIFY_AUTH_TOKEN: se omite Netlify (se conservan los sitios actuales)');
    return null;
  }
  log('consultando sitios de Netlify...');
  const sitios = await pedirTodo('https://api.netlify.com/api/v1/sites', {
    Authorization: `Bearer ${TOKEN_NETLIFY}`,
    'User-Agent': 'portfolioDR-sync'
  });
  log(`${sitios.length} sitios en Netlify`);
  return sitios;
}

// ----------------------------------------------------------------------------
// Cruce GitHub <-> Netlify
// ----------------------------------------------------------------------------

/**
 * Elige el repo que corresponde a un sitio de Netlify, en orden de confianza:
 *   1. El repo que Netlify declara como origen del build.
 *   2. Un repo cuyo homepage apunte a la URL del sitio.
 *   3. Un repo cuyo nombre normalizado coincida con el subdominio.
 */
function repoDeSitio(sitio, repos) {
  const ruta = sitio?.build_settings?.repo_path;
  if (ruta) {
    const nombre = normalizar(ruta.split('/').pop());
    const exacto = repos.find(r => normalizar(r.name) === nombre);
    if (exacto) return exacto;
  }

  const urlSitio = sitio.ssl_url || sitio.url || '';
  const hostSitio = host(urlSitio);
  if (hostSitio) {
    const porHomepage = repos.find(r => r.homepage && host(r.homepage) === hostSitio);
    if (porHomepage) return porHomepage;
  }

  const sub = normalizar(sitio.name);
  return repos.find(r => normalizar(r.name) === sub) || null;
}

/**
 * ¿Son el mismo proyecto dos nombres que no coinciden letra por letra?
 *
 * Los repos y los subdominios de Netlify rara vez son idénticos: sobra un
 * sufijo numérico o una letra repetida ("hostelapp" vs "hostelapp1",
 * "cvcreator" vs "cvcreatorr"). Se acepta que uno sea prefijo del otro con
 * hasta dos caracteres de diferencia; más margen empezaría a unir proyectos
 * distintos.
 */
function parecidos(a, b) {
  const x = normalizar(a);
  const y = normalizar(b);
  if (!x || !y) return false;
  if (x === y) return true;

  const [corto, largo] = x.length <= y.length ? [x, y] : [y, x];
  if (corto.length < 4) return false; // nombres muy cortos dan falsos positivos
  return largo.startsWith(corto) && largo.length - corto.length <= 2;
}

function inferirCategoria(fuentes) {
  const texto = normalizar(fuentes.filter(Boolean).join(' '));
  return PISTAS_EDU.some(pista => texto.includes(normalizar(pista))) ? 'edu' : 'web';
}

/** Miniatura generada al vuelo, con cache-busting por fecha de actualización. */
function miniaturaAutomatica(url, sello) {
  if (!url) return null;
  const bust = sello ? `?v=${encodeURIComponent(String(sello).slice(0, 10))}` : '';
  return `https://image.thum.io/get/width/1200/crop/675/noanimate/${url}${bust}`;
}

/**
 * Decide la vista previa de un proyecto.
 *
 * La captura oficial de Netlify siempre gana: se regenera en cada despliegue.
 * Sin ella, solo se pide una miniatura nueva cuando el proyecto realmente
 * cambió (o cuando todavía no tenía imagen), para no descartar capturas que
 * ya funcionan ni castigar al servicio de miniaturas en cada sincronización.
 */
function resolverScreenshot({ proyecto, sitio, selloPrevio }) {
  if (sitio?.screenshot_url) return sitio.screenshot_url;
  const cambio = proyecto.updatedAt !== selloPrevio;
  if (!proyecto.screenshot || cambio) {
    return miniaturaAutomatica(proyecto.url, proyecto.updatedAt);
  }
  return proyecto.screenshot;
}

// ----------------------------------------------------------------------------
// Construcción del documento
// ----------------------------------------------------------------------------

function construir({ repos, utiles, sitios, previo, overrides }) {
  const ocultos = new Set((overrides.hidden || []).map(normalizar));
  const anteriores = new Map((previo.projects || []).map(p => [p.id, p]));

  /** id -> proyecto en construcción */
  const salida = new Map();

  const registrar = (id, base) => {
    if (!id || ocultos.has(normalizar(id))) return null;
    const acumulado = salida.get(id) || { ...(anteriores.get(id) || {}), id };
    Object.assign(acumulado, base);
    salida.set(id, acumulado);
    return acumulado;
  };

  const reposUsados = new Set();

  // --- 1. Sitios de Netlify (fuente de la URL en vivo y el screenshot) -------
  if (sitios) {
    for (const sitio of sitios) {
      const url = sitio.ssl_url || sitio.url;
      if (!url) continue;

      const id = subdominio(url) || normalizar(sitio.name);
      if (!id || ocultos.has(normalizar(id))) continue;

      const repo = repoDeSitio(sitio, utiles);
      if (repo) reposUsados.add(repo.id);

      const publicado = sitio.published_deploy?.published_at || sitio.updated_at;
      const sello = repo?.pushed_at || publicado;

      const proyecto = registrar(id, {});
      if (!proyecto) continue;

      // Se guarda antes de pisarlo: sirve para saber si el proyecto cambió.
      const selloPrevio = proyecto.updatedAt;
      proyecto.url = url;
      enriquecer(proyecto, 'name', proyecto.name || titular(sitio.name));
      enriquecer(proyecto, 'desc', repo?.description);
      enriquecer(proyecto, 'repo', repo?.html_url);
      enriquecer(proyecto, 'repoName', repo?.name);
      enriquecer(proyecto, 'language', repo?.language);
      enriquecer(proyecto, 'languages', repo?._languages);
      enriquecer(proyecto, 'topics', repo?.topics);
      proyecto.stars = repo?.stargazers_count ?? proyecto.stars ?? 0;
      proyecto.archived = repo?.archived ?? proyecto.archived ?? false;

      enriquecer(proyecto, 'updatedAt', aISO(sello));
      enriquecer(proyecto, 'updated', fechaLegible(proyecto.updatedAt));

      enriquecer(proyecto, 'screenshot', resolverScreenshot({ proyecto, sitio, selloPrevio }));

      proyecto.category =
        proyecto.category ||
        inferirCategoria([sitio.name, repo?.name, repo?.description, ...(repo?.topics || [])]);
    }
  }

  // --- 2. Sin datos de Netlify, se parte de lo que ya había -----------------
  // Tiene que ir ANTES de emparejar repos: si no, las fases siguientes no
  // tendrían con qué cruzar y darían de alta duplicados en vez de enriquecer.
  // Con datos de Netlify no se restaura nada: su lista manda sobre qué existe.
  if (!sitios) {
    for (const [id, proyecto] of anteriores) {
      if (!salida.has(id) && !ocultos.has(normalizar(id))) salida.set(id, { ...proyecto });
    }
  }

  // --- 3. Repos con homepage que Netlify no cubrió --------------------------
  for (const repo of utiles) {
    if (reposUsados.has(repo.id)) continue;
    if (ocultos.has(normalizar(repo.name))) continue;
    if (!repo.homepage) continue;

    const propuesto = subdominio(repo.homepage) || normalizar(repo.name);
    if (!propuesto || ocultos.has(normalizar(propuesto))) continue;

    // Antes de dar de alta un proyecto nuevo se busca uno ya existente que sea
    // el mismo con otro nombre, para no duplicar la tarjeta.
    const gemelo = [...salida.values()].find(
      p => !p.repo && (parecidos(p.id, propuesto) || parecidos(p.id, repo.name))
    );
    const id = gemelo ? gemelo.id : propuesto;

    // Si Netlify ya publicó este id, solo completamos lo que falte.
    const proyecto = registrar(id, {});
    if (!proyecto) continue;

    const selloPrevio = proyecto.updatedAt;
    proyecto.url = proyecto.url || repo.homepage;
    enriquecer(proyecto, 'name', proyecto.name || titular(repo.name));
    enriquecer(proyecto, 'desc', repo.description);
    enriquecer(proyecto, 'repo', repo.html_url);
    enriquecer(proyecto, 'repoName', repo.name);
    enriquecer(proyecto, 'language', repo.language);
    enriquecer(proyecto, 'languages', repo._languages);
    enriquecer(proyecto, 'topics', repo.topics);
    proyecto.stars = repo.stargazers_count ?? proyecto.stars ?? 0;
    proyecto.archived = repo.archived ?? proyecto.archived ?? false;

    enriquecer(proyecto, 'updatedAt', aISO(repo.pushed_at));
    enriquecer(proyecto, 'updated', fechaLegible(proyecto.updatedAt));
    enriquecer(proyecto, 'screenshot', resolverScreenshot({ proyecto, sitio: null, selloPrevio }));

    proyecto.category =
      proyecto.category || inferirCategoria([repo.name, repo.description, ...(repo.topics || [])]);
  }

  // --- 4. Enlazar los repos que quedaron sueltos ----------------------------
  // Sin token de Netlify no existe el cruce exacto por build, así que aquí se
  // emparejan por nombre los repos que todavía no se asociaron a ningún
  // proyecto. Es lo que da lenguaje y enlace al código a la mayoría de las
  // tarjetas cuando solo hay datos de GitHub.
  for (const repo of utiles) {
    if (reposUsados.has(repo.id)) continue;
    if (ocultos.has(normalizar(repo.name))) continue;

    const candidatos = [...salida.values()];
    const objetivo =
      // 1. El repo que ya teníamos anotado para ese proyecto (sobrevive a renombres).
      candidatos.find(p => p.repoName && normalizar(p.repoName) === normalizar(repo.name)) ||
      // 2. Coincidencia exacta con el id del proyecto.
      candidatos.find(p => !p.repo && normalizar(p.id) === normalizar(repo.name)) ||
      // 3. Variantes de nombre: sufijos numéricos, letras repetidas, etc.
      candidatos.find(p => !p.repo && parecidos(p.id, repo.name));
    if (!objetivo) continue;

    reposUsados.add(repo.id);

    enriquecer(objetivo, 'repo', repo.html_url);
    enriquecer(objetivo, 'repoName', repo.name);
    enriquecer(objetivo, 'language', repo.language);
    enriquecer(objetivo, 'languages', repo._languages);
    enriquecer(objetivo, 'topics', repo.topics);
    enriquecer(objetivo, 'desc', repo.description);
    const selloPrevio = objetivo.updatedAt;
    const empujado = aISO(repo.pushed_at);
    if (empujado) {
      objetivo.updatedAt = empujado;
      objetivo.updated = fechaLegible(empujado);
    }
    enriquecer(objetivo, 'screenshot', resolverScreenshot({ proyecto: objetivo, sitio: null, selloPrevio }));
  }

  // --- 5. Curaduría manual: siempre gana ------------------------------------
  const manuales = overrides.projects || {};
  for (const [id, campos] of Object.entries(manuales)) {
    const proyecto = salida.get(id);
    if (proyecto) Object.assign(proyecto, campos);
  }

  const proyectos = [...salida.values()]
    .filter(p => p.url)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  // --- Diagnóstico: qué quedó sin cruzar ------------------------------------
  const sinRepo = proyectos.filter(p => !p.repo).map(p => p.id);
  const reposSueltos = utiles
    .filter(r => !reposUsados.has(r.id) && !ocultos.has(normalizar(r.name)))
    .map(r => r.name);

  if (sinRepo.length) log(`proyectos sin repo enlazado (${sinRepo.length}): ${sinRepo.join(', ')}`);
  if (reposSueltos.length) log(`repos sin proyecto (${reposSueltos.length}): ${reposSueltos.join(', ')}`);
  if (!sitios && (sinRepo.length || reposSueltos.length)) {
    log('sugerencia: configura NETLIFY_AUTH_TOKEN para cruzar por el repo del build,');
    log('            o define el campo "homepage" en esos repos de GitHub.');
  }

  return {
    generatedAt: new Date().toISOString(),
    source: { github: true, netlify: Boolean(sitios), seed: false },
    stats: {
      repos: repos.length,
      sites: sitios ? sitios.length : (previo.stats?.sites ?? proyectos.length),
      published: proyectos.length
    },
    projects: proyectos
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const previo = existsSync(RUTA_PROYECTOS)
    ? JSON.parse(readFileSync(RUTA_PROYECTOS, 'utf8'))
    : { projects: [] };
  const overrides = existsSync(RUTA_OVERRIDES)
    ? JSON.parse(readFileSync(RUTA_OVERRIDES, 'utf8'))
    : {};

  const [{ repos, utiles }, sitios] = await Promise.all([leerGitHub(), leerNetlify()]);
  const doc = construir({ repos, utiles, sitios, previo, overrides });

  log(`${doc.projects.length} proyectos publicados`);
  for (const p of doc.projects) {
    log(`  · ${p.id.padEnd(28)} ${(p.language || '—').padEnd(12)} ${p.repo || 'sin repo'}`);
  }

  const contenido = JSON.stringify(doc, null, 2) + '\n';

  if (DRY_RUN) {
    log('--dry-run: no se escribió nada');
    return;
  }

  // Se ignora generatedAt al comparar para no commitear cambios vacíos.
  const sinSello = txt => txt.replace(/"generatedAt": "[^"]*"/, '"generatedAt": ""');
  const anterior = existsSync(RUTA_PROYECTOS) ? readFileSync(RUTA_PROYECTOS, 'utf8') : '';
  if (sinSello(anterior) === sinSello(contenido)) {
    log('sin cambios');
    return;
  }

  writeFileSync(RUTA_PROYECTOS, contenido);
  log('data/projects.json actualizado');
}

main().catch(err => {
  console.error('[sync] error:', err.message);
  process.exit(1);
});
