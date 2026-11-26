// Module loader hooks for the page: an import of "/js/x.mjs" from a module of
// public/ resolves under public/, as the browser resolves it against the
// page's origin, and every .js file under public/ loads as an ES module.

let publicURL = null;

export async function initialize(data) {
  publicURL = data.publicURL;
}

export async function resolve(specifier, context, next) {
  const parent = context.parentURL || '';
  if (publicURL && parent.startsWith(publicURL) && specifier.startsWith('/') && !specifier.startsWith('//')) {
    return next(new URL(specifier.slice(1), publicURL).href, context);
  }
  if (publicURL && parent.startsWith(publicURL) && /^https?:\/\//.test(specifier)) {
    throw new Error(`the page imports ${specifier} from the network; the planner must load no external module`);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (publicURL && url.startsWith(publicURL) && /\.js(\?.*)?$/.test(url)) {
    return next(url, { ...context, format: 'module' });
  }
  return next(url, context);
}
