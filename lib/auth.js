// lib/auth.js — inlog met wachtwoord + TOTP-2FA (zoals bij bestelkozijnenopmaat)
// Eerste keer: wachtwoord → QR scannen → code bevestigen → 2FA actief.
// Daarna: wachtwoord + 6-cijferige code.
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const { pool } = require('../db');

const WACHTWOORD = process.env.ADMIN_WACHTWOORD;

async function getInstelling(sleutel) {
  const { rows } = await pool.query('SELECT waarde FROM instellingen WHERE sleutel = $1', [sleutel]);
  return rows[0] ? rows[0].waarde : null;
}
async function setInstelling(sleutel, waarde) {
  await pool.query(
    `INSERT INTO instellingen (sleutel, waarde) VALUES ($1, $2)
     ON CONFLICT (sleutel) DO UPDATE SET waarde = EXCLUDED.waarde`, [sleutel, waarde]);
}

function eisLogin(req, res, next) {
  if (!WACHTWOORD) return next(); // geen wachtwoord ingesteld → tool open (lokaal testen)
  if (req.session && req.session.ingelogd) return next();
  res.redirect('/login');
}

function registreerRoutes(app) {
  app.get('/login', async (req, res) => {
    res.render('login', { fout: null, stap: 'wachtwoord' });
  });

  app.post('/login', async (req, res) => {
    if (!WACHTWOORD) return res.redirect('/');
    if ((req.body.wachtwoord || '') !== WACHTWOORD) {
      await new Promise(r => setTimeout(r, 800)); // brute-force remmen
      return res.render('login', { fout: 'Onjuist wachtwoord.', stap: 'wachtwoord' });
    }
    const secret = await getInstelling('totp_secret');
    const actief = (await getInstelling('totp_actief')) === 'ja';

    if (!secret || !actief) {
      // 2FA-setup: nieuw secret + QR tonen
      const nieuw = secret || authenticator.generateSecret();
      if (!secret) await setInstelling('totp_secret', nieuw);
      req.session.wachtwoordOk = true;
      const uri = authenticator.keyuri('admin', 'RankWerk', nieuw);
      const qr = await qrcode.toDataURL(uri);
      return res.render('login', { fout: null, stap: 'setup', qr, secret: nieuw });
    }
    req.session.wachtwoordOk = true;
    res.render('login', { fout: null, stap: 'code' });
  });

  app.post('/login/code', async (req, res) => {
    if (!req.session.wachtwoordOk) return res.redirect('/login');
    const secret = await getInstelling('totp_secret');
    const token = (req.body.code || '').replace(/\s/g, '');
    const ok = secret && authenticator.verify({ token, secret });
    if (!ok) {
      const actief = (await getInstelling('totp_actief')) === 'ja';
      if (!actief) {
        const uri = authenticator.keyuri('admin', 'RankWerk', secret);
        const qr = await qrcode.toDataURL(uri);
        return res.render('login', { fout: 'Code klopt niet, probeer opnieuw.', stap: 'setup', qr, secret });
      }
      return res.render('login', { fout: 'Code klopt niet.', stap: 'code' });
    }
    await setInstelling('totp_actief', 'ja');
    req.session.ingelogd = true;
    delete req.session.wachtwoordOk;
    res.redirect('/');
  });

  app.post('/uitloggen', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });
}

module.exports = { eisLogin, registreerRoutes };
