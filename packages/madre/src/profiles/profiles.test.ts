import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkAction, planSchedule, similarity, validateProfile, type Profile } from './multi-profile.ts';

const p = (id: string, extra: Partial<Profile> = {}): Profile => ({ id, platform: 'instagram', handle: `@${id}`, ownership: 'own', credentialRef: `VAULT_${id.toUpperCase()}`, dailyLimit: 2, purpose: 'Italian market', ...extra });

describe('multi-profile operations', () => {
  it('accepts own accounts with a credential reference', () => {
    assert.deepEqual(validateProfile(p('a')), []);
  });

  it('rejects real-looking secrets, missing refs and bad limits', () => {
    assert.ok(validateProfile(p('a', { purpose: 'contraseña: correcaminos' })).length > 0);
    assert.ok(validateProfile(p('a', { credentialRef: 'sk-abcdefghijklmnop' })).length > 0);
    assert.ok(validateProfile(p('a', { credentialRef: '' })).length > 0);
    assert.ok(validateProfile(p('a', { dailyLimit: 0 })).length > 0);
    assert.ok(validateProfile(p('a', { ownership: 'stolen' as never })).length > 0);
  });

  for (const [text, id] of [
    ['use rotating residential proxies for each account', 'proxy-rotation'],
    ['spoof the browser fingerprint per profile', 'fingerprint-spoofing'],
    ['add a captcha solver', 'captcha-solving'],
    ['create fake accounts to comment', 'fake-accounts'],
    ['buy followers for the launch', 'engagement-manipulation'],
    ['avoid detection by the platform', 'ban-evasion'],
    ['usar proxies residenciales rotativos para cada cuenta', 'proxy-rotation'],
    ['rotación de IPs entre los perfiles', 'proxy-rotation'],
    ['suplantar la huella del navegador en cada perfil', 'fingerprint-spoofing'],
    ['usar un navegador de anti-detección', 'fingerprint-spoofing'],
    ['automatizar captchas con un servicio externo', 'captcha-solving'],
    ['saltarse el captcha del registro', 'captcha-solving'],
    ['crear cuentas falsas para comentar', 'fake-accounts'],
    ['montar una granja de cuentas para el lanzamiento', 'fake-accounts'],
    ['comprar seguidores para el lanzamiento', 'engagement-manipulation'],
    ['entrar en un grupo de engagement entre marcas', 'engagement-manipulation'],
    ['eludir la detección de la plataforma', 'ban-evasion'],
    ['evasión de baneo abriendo cuentas nuevas', 'ban-evasion'],
    ['saltarse el límite de peticiones de la API', 'ban-evasion'],
  ] as const) {
    it(`refuses: ${id}`, () => {
      const r = checkAction(text);
      assert.equal(r.allowed, false);
      assert.ok(r.refusals.some((x) => x.id === id), JSON.stringify(r));
    });
  }

  it('allows ordinary coordination', () => {
    assert.equal(checkAction('Schedule one post per day on each of our brand accounts').allowed, true);
    assert.equal(checkAction('Programar una publicación al día en cada una de nuestras cuentas de marca').allowed, true);
    assert.equal(checkAction('Traducir el mismo mensaje al italiano para el mercado de Italia').allowed, true);
    assert.equal(checkAction('Responder cada mañana los comentarios de los clientes').allowed, true);
  });

  it('measures similarity', () => {
    assert.equal(similarity('fresh cookies delivered daily across Italy', 'fresh cookies delivered daily across Italy'), 1);
    assert.ok(similarity('fresh cookies delivered daily across Italy', 'a totally different sentence about winter coats') < 0.1);
  });

  it('enforces daily limits and refuses the same text on several accounts', () => {
    const profiles = [p('a'), p('b')];
    const r = planSchedule(profiles, [
      { profileId: 'a', day: 'd1', content: 'Our new pistachio cookie is here and it ships across Italy this week' },
      { profileId: 'b', day: 'd1', content: 'Our new pistachio cookie is here and it ships across Italy this week' },
      { profileId: 'b', day: 'd1', content: 'Behind the scenes: how we bake at five in the morning' },
      { profileId: 'b', day: 'd1', content: 'Customer question of the week about storing cookies' },
      { profileId: 'b', day: 'd1', content: 'Third different post exceeds the limit' },
      { profileId: 'zzz', day: 'd1', content: 'x' },
    ]);
    assert.equal(r.accepted.length, 3);
    assert.equal(r.rejected.length, 3);
    assert.match(r.rejected[0]!.reason, /casi idéntico/);
    assert.match(r.rejected[1]!.reason, /límite diario de 2 publicaciones/);
    assert.match(r.rejected[2]!.reason, /Perfil desconocido/);
    assert.equal(r.perProfile.b, 2);
  });
});
