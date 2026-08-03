/* Version skew's other face: the lazy import *succeeds* (the CDN serves the new
   deployment's module), but the old client's route tree doesn't line up with
   what it exports, and the router's load dies reading `.component` (the route
   entry) or `.default` (the module itself) off undefined. No chunk-load pattern
   matches, since the fetch worked.

   Every engine words that read differently, so match all three: a client on
   Firefox or Safari is exactly as stale as one on Chrome, and matching only
   V8's phrasing left them on the error screen with no refresh. */
const STALE_ROUTE_MODULE_PATTERNS = [
  // V8: Cannot read properties of undefined (reading 'component')
  /cannot read propert(?:y|ies) of (?:undefined|null) \(reading '(?:component|default)'\)/,
  // Older V8: Cannot read property 'component' of undefined
  /cannot read property '(?:component|default)' of (?:undefined|null)/,
  // SpiderMonkey: can't access property "component", d is undefined
  /can't access property "(?:component|default)", \S+ is (?:undefined|null)/,
  // JavaScriptCore: undefined is not an object (evaluating 'd.component')
  /(?:undefined|null) is not an object \(evaluating '[^']*\.(?:component|default)'\)/,
];

/** Whether an error message reads like a stale client meeting a new deployment's
    route modules, rather than a genuine app bug. */
export function isStaleRouteModuleMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return STALE_ROUTE_MODULE_PATTERNS.some((pattern) => pattern.test(normalized));
}
