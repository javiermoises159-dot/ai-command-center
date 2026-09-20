/**
 * Multi-profile operations.
 *
 * Coordinates work across several accounts the operator owns or is authorised
 * to run — a business with a brand account per market, say. It does NOT help
 * accounts pass as independent people, and it refuses techniques whose only
 * purpose is to avoid a platform's controls.
 *
 * Profiles hold a reference to where credentials live (`credentialRef`), never
 * the secret itself.
 */

export interface Profile {
  id: string;
  platform: string;
  handle: string;
  ownership: 'own' | 'authorized';
  /** Name of a server-side secret or vault entry. Never a password or token. */
  credentialRef: string;
  /** Posts per day the operator allows. */
  dailyLimit: number;
  /** Open notes such as the market or the language. */
  purpose: string;
}

/** Techniques this module will not plan or run. Matched on the requested action. */
export const FORBIDDEN_TECHNIQUES: readonly { id: string; pattern: RegExp; reason: string }[] = [
  {
    id: 'proxy-rotation',
    pattern:
      /(rotat\w*\s+(residential\s+)?(proxy|proxies|ip)|residential\s+prox|ip\s+rotation|rot(?:ar|ando|aci[oó]n\w*)\s+(?:de\s+|las\s+|los\s+)*(?:proxies|proxys|proxy|ips?|direcciones\s+ip)|prox(?:y|ies|ys)\s+residencial(?:es)?|rotaci[oó]n\s+de\s+(?:ips?|direcciones))/i,
    reason: 'Rotar proxies o IP para que las cuentas parezcan no relacionadas es evadir los controles de la plataforma.',
  },
  {
    id: 'fingerprint-spoofing',
    pattern:
      /(fingerprint\s+spoof|spoof\w*\s+(the\s+)?(\w+\s+)?(fingerprint|user[- ]agent|device)|anti[- ]detect|antidetect|(?:suplantar|suplantaci[oó]n\s+de|falsear|falsificar|enmascarar|camuflar|cambiar)\s+(?:la\s+|el\s+|los\s+|las\s+|de\s+)*(?:huella\w*|fingerprint|user[- ]agent|agente\s+de\s+usuario|dispositivo|navegador)|huella\s+(?:digital\s+)?(?:del\s+navegador\s+)?(?:falsa|falseada|suplantada)|anti[- ]?detecci[oó]n)/i,
    reason: 'Suplantar la huella del dispositivo o del navegador es evadir los controles de la plataforma.',
  },
  {
    id: 'captcha-solving',
    pattern:
      /(captcha\s*(solv|bypass|farm)|solv\w*\s+captcha|bypass\w*\s+captcha|(?:resolver|resolviendo|resoluci[oó]n\s+de|saltar(?:se)?|sortear|eludir|evadir|burlar|automatizar|automatizaci[oó]n\s+de|bypasse?ar)\s+(?:el\s+|los\s+|un\s+|las\s+|la\s+)*captchas?|granja\s+de\s+captchas?|captchas?\s+autom[aá]tic\w*)/i,
    reason: 'Burlar los captchas elude un control anti-bot.',
  },
  {
    id: 'fake-accounts',
    pattern:
      /(fake\s+(account|profile|persona|follower)|sock\s*puppet|sockpuppet|bulk\s+account\s+creation|mass\s+account\s+creation|(?:cuentas?|perfiles?|personas?|seguidor(?:es)?|identidades?)\s+(?:falsa|falsas|falso|falsos|ficticia|ficticias|ficticio|ficticios|inventad\w*|fantasma\w*)|creaci[oó]n\s+(?:masiva|en\s+masa)\s+de\s+cuentas|crear\s+cuentas\s+(?:en\s+masa|masivamente)|granja\s+de\s+cuentas|cuentas?\s+t[ií]tere\w*)/i,
    reason: 'Las cuentas falsas o creadas en masa son engañosas e incumplen las normas de las plataformas.',
  },
  {
    id: 'engagement-manipulation',
    pattern:
      /(buy\w*\s+(likes|followers|views)|engagement\s+pod|artificial\s+engagement|like\s+farm|compr(?:ar|a|amos|o|ando)\s+(?:de\s+|unos\s+|los\s+|las\s+)*(?:likes|me\s+gusta|seguidores|visitas|visualizaciones|reproducciones|suscriptores)|(?:interacci[oó]n|participaci[oó]n|engagement)\s+(?:artificial|falsa|inflad\w*)|grupo\s+de\s+(?:engagement|interacci[oó]n|apoyo\s+mutuo)|granja\s+de\s+(?:likes|me\s+gusta|seguidores|clics))/i,
    reason: 'La interacción artificial engaña al público y a las plataformas.',
  },
  {
    id: 'ban-evasion',
    pattern:
      /(ban\s+evasion|evad\w+\s+(a\s+)?(ban|suspension)|avoid\w*\s+(detection|shadow\s*ban)|bypass\w*\s+(rate\s+limit|anti[- ]?bot)|(?:evasi[oó]n|elusi[oó]n)\s+(?:de\s+)?(?:baneo|ban|bloqueo|suspensi[oó]n|detecci[oó]n|controles?|l[ií]mites?)|(?:evadir|eludir|esquivar|sortear|burlar|saltar(?:se)?|evitar|bypasse?ar)\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+|su\s+)*(?:baneo|ban|bloqueo|suspensi[oó]n|detecci[oó]n|shadow\s*ban|shadowban|anti[- ]?bot|l[ií]mite\s+de\s+(?:peticiones|solicitudes|tasa|publicaciones)|controles?\s+(?:de\s+la\s+plataforma|antibot)))/i,
    reason: 'Evadir un baneo, la detección o un límite de peticiones anula un control que la plataforma puso a propósito.',
  },
];

export interface ProfileIssue {
  profileId: string | null;
  problem: string;
}

const SECRET_LIKE = /(sk-[a-z0-9]{10,}|ghp_[a-z0-9]{10,}|eyJ[a-z0-9_-]{10,}\.|password\s*[:=]|contrase[nñ]a\s*[:=]|clave\s*[:=]|bearer\s+[a-z0-9._-]{12,})/i;

export function validateProfile(profile: Profile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const p = (problem: string) => issues.push({ profileId: profile.id, problem });
  if (profile.ownership !== 'own' && profile.ownership !== 'authorized') p('Solo se pueden añadir cuentas que te pertenezcan o que estés autorizado a operar.');
  if (profile.credentialRef.trim() === '') p('Indica una referencia de credencial (el nombre de un secreto guardado), no el secreto.');
  if (SECRET_LIKE.test(profile.credentialRef) || SECRET_LIKE.test(profile.purpose)) p('Esto parece un secreto real. Guárdalo en el entorno del servidor y referéncialo por su nombre.');
  if (!(profile.dailyLimit > 0)) p('Fija un límite diario de publicaciones mayor que cero.');
  return issues;
}

export function checkAction(description: string): { allowed: boolean; refusals: { id: string; reason: string }[] } {
  const refusals = FORBIDDEN_TECHNIQUES.filter((t) => t.pattern.test(description)).map((t) => ({ id: t.id, reason: t.reason }));
  return { allowed: refusals.length === 0, refusals };
}

export interface PlannedPost {
  profileId: string;
  content: string;
  day: string;
}

function fingerprint(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);
  const grams = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) grams.add(words.slice(i, i + 3).join(' '));
  return grams;
}

export function similarity(a: string, b: string): number {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  if (fa.size === 0 || fb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== '' ? 1 : 0;
  let shared = 0;
  for (const g of fa) if (fb.has(g)) shared++;
  return shared / (fa.size + fb.size - shared);
}

export interface ScheduleResult {
  accepted: PlannedPost[];
  rejected: { post: PlannedPost; reason: string }[];
  perProfile: Record<string, number>;
}

/**
 * Validates a posting plan across profiles: limits per profile and day, and no
 * near-identical text pushed through several accounts (which would be spam
 * dressed as independent voices).
 */
export function planSchedule(profiles: readonly Profile[], posts: readonly PlannedPost[], maxSimilarity = 0.6): ScheduleResult {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const accepted: PlannedPost[] = [];
  const rejected: ScheduleResult['rejected'] = [];
  const perDay = new Map<string, number>();
  for (const post of posts) {
    const profile = byId.get(post.profileId);
    if (profile === undefined) { rejected.push({ post, reason: 'Perfil desconocido.' }); continue; }
    if (validateProfile(profile).length > 0) { rejected.push({ post, reason: 'El perfil no es válido; corrígelo primero.' }); continue; }
    const key = `${post.profileId}|${post.day}`;
    if ((perDay.get(key) ?? 0) >= profile.dailyLimit) { rejected.push({ post, reason: `Se ha alcanzado el límite diario de ${profile.dailyLimit} ${profile.dailyLimit === 1 ? 'publicación' : 'publicaciones'} de ${profile.handle}.` }); continue; }
    const twin = accepted.find((a) => a.profileId !== post.profileId && similarity(a.content, post.content) >= maxSimilarity);
    if (twin !== undefined) { rejected.push({ post, reason: 'Ya hay contenido casi idéntico planificado en otra cuenta. Escribe algo distinto para cada público.' }); continue; }
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
    accepted.push(post);
  }
  const perProfile: Record<string, number> = {};
  for (const a of accepted) perProfile[a.profileId] = (perProfile[a.profileId] ?? 0) + 1;
  return { accepted, rejected, perProfile };
}
