import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate';
import { sendSuccess } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';
import { query } from '../../config/database';
import { logger } from '../../utils/logger';

/* Area search: country → state → city → area (Google Places), then nearby
   hospitals, trauma centres, ambulances, chemists, Deemona doctors and
   emergency numbers. The Google key stays on the server (GOOGLE_MAPS_API_KEY). */

const router = Router();
const PLACES = 'https://places.googleapis.com/v1';

// country-state-city is loaded lazily so the API still starts if it isn't installed yet.
let csc: any = null;
function geo() {
  if (!csc) {
    try { csc = require('country-state-city'); }
    catch { throw new AppError(503, 'GEO_DATA_MISSING', 'Location data is not installed on the server yet.'); }
  }
  return csc;
}

function key() {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (!k) throw new AppError(503, 'MAPS_NOT_CONFIGURED', 'Area search is not configured yet.');
  return k;
}

async function google(path: string, body: any | null, fieldMask: string, method: 'GET' | 'POST' = 'POST') {
  const res = await fetch(`${PLACES}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': fieldMask },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.error('Google Places error', { path, status: res.status, message: json?.error?.message });
    throw new AppError(502, 'MAPS_ERROR', 'Could not load places right now.');
  }
  return json;
}

const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const isCode = (v: any) => typeof v === 'string' && /^[A-Za-z0-9-]{1,6}$/.test(v);

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

const DENTAL = /dent|orthodont|endodont|oral\s*surg|maxillofacial/i;
const PLACE_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'internationalPhoneNumber',
  'rating', 'userRatingCount', 'googleMapsUri', 'websiteUri', 'currentOpeningHours.openNow',
  'location', 'types', 'businessStatus',
].map(f => `places.${f}`).join(',');

function shape(list: any[] | undefined, center: { lat: number; lng: number }) {
  return (list || [])
    .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .filter(p => !(p.types || []).some((t: string) => t === 'dentist' || t === 'dental_clinic') && !DENTAL.test(p.displayName?.text || ''))
    .map(p => ({
      id: p.id,
      name: p.displayName?.text,
      address: p.formattedAddress,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
      phone_intl: p.internationalPhoneNumber || null,
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? 0,
      open_now: p.currentOpeningHours?.openNow ?? null,
      website: p.websiteUri || null,
      maps_url: p.googleMapsUri || null,
      distance_km: p.location ? km(center, { lat: p.location.latitude, lng: p.location.longitude }) : null,
    }))
    .sort((a, b) => (a.distance_km ?? 99) - (b.distance_km ?? 99));
}

const EMERGENCY: Record<string, { label: string; number: string }[]> = {
  IN: [
    { label: 'National emergency', number: '112' },
    { label: 'Ambulance', number: '108' },
    { label: 'Ambulance (pregnancy & child)', number: '102' },
    { label: 'Police', number: '100' },
    { label: 'Fire', number: '101' },
    { label: 'Women helpline', number: '1091' },
    { label: 'Child helpline', number: '1098' },
    { label: 'Mental health (Tele-MANAS)', number: '14416' },
  ],
  US: [{ label: 'Emergency', number: '911' }, { label: 'Suicide & crisis line', number: '988' }],
  CA: [{ label: 'Emergency', number: '911' }],
  GB: [{ label: 'Emergency', number: '999' }, { label: 'NHS non-emergency', number: '111' }],
  AU: [{ label: 'Emergency', number: '000' }],
  AE: [{ label: 'Ambulance', number: '998' }, { label: 'Police', number: '999' }],
};

const lookupLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.sub || req.ip });
const nearbyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.sub || req.ip,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many area searches. Please wait a few minutes.' } } });

/* ── dropdown data ─────────────────────────────────────────────────── */

router.get('/countries', authenticate, lookupLimiter, (_req, res, next) => {
  try {
    const list = geo().Country.getAllCountries().map((c: any) => ({ code: c.isoCode, name: c.name, flag: c.flag }));
    sendSuccess(res, list);
  } catch (e) { next(e); }
});

router.get('/states', authenticate, lookupLimiter, (req, res, next) => {
  try {
    const country = String(req.query.country || '');
    if (!isCode(country)) throw new AppError(400, 'BAD_REQUEST', 'country required.');
    sendSuccess(res, geo().State.getStatesOfCountry(country).map((s: any) => ({ code: s.isoCode, name: s.name })));
  } catch (e) { next(e); }
});

router.get('/cities', authenticate, lookupLimiter, (req, res, next) => {
  try {
    const country = String(req.query.country || ''), state = String(req.query.state || '');
    if (!isCode(country) || !isCode(state)) throw new AppError(400, 'BAD_REQUEST', 'country and state required.');
    const list = geo().City.getCitiesOfState(country, state).map((c: any) => ({ name: c.name, lat: num(c.latitude), lng: num(c.longitude) }));
    sendSuccess(res, list);
  } catch (e) { next(e); }
});

// Area suggestions (localities, neighbourhoods, PIN codes) near the chosen city.
router.get('/areas', authenticate, lookupLimiter, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const lat = num(req.query.lat), lng = num(req.query.lng);
    const country = String(req.query.country || '');
    const session = String(req.query.session || '').slice(0, 64);
    if (q.length < 2) { sendSuccess(res, []); return; }
    const body: any = { input: q, includedPrimaryTypes: ['(regions)'] };
    if (isCode(country)) body.includedRegionCodes = [country.toLowerCase()];
    if (Number.isFinite(lat) && Number.isFinite(lng)) body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 30000 } };
    if (session) body.sessionToken = session;
    const data = await google('/places:autocomplete', body, 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text');
    const list = (data.suggestions || []).map((s: any) => s.placePrediction).filter(Boolean)
      .map((p: any) => ({ place_id: p.placeId, text: p.text?.text }));
    sendSuccess(res, list);
  } catch (e) { next(e); }
});

router.get('/area', authenticate, lookupLimiter, async (req, res, next) => {
  try {
    const id = String(req.query.place_id || '');
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) throw new AppError(400, 'BAD_REQUEST', 'place_id required.');
    const session = String(req.query.session || '').slice(0, 64);
    const p = await google(`/places/${encodeURIComponent(id)}${session ? `?sessionToken=${encodeURIComponent(session)}` : ''}`, null,
      'id,displayName,formattedAddress,location,addressComponents', 'GET');
    const postal = (p.addressComponents || []).find((c: any) => (c.types || []).includes('postal_code'))?.longText || null;
    sendSuccess(res, {
      place_id: p.id, name: p.displayName?.text, address: p.formattedAddress, postal_code: postal,
      lat: p.location?.latitude, lng: p.location?.longitude,
    });
  } catch (e) { next(e); }
});

/* ── everything near the selected area ─────────────────────────────── */

router.get('/nearby', authenticate, nearbyLimiter, async (req, res, next) => {
  try {
    const lat = num(req.query.lat), lng = num(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new AppError(400, 'BAD_REQUEST', 'lat and lng required.');
    const city = String(req.query.city || '').slice(0, 60);
    const country = String(req.query.country || 'IN').toUpperCase();
    const center = { lat, lng };
    const circle = (radius: number) => ({ circle: { center: { latitude: lat, longitude: lng }, radius } });

    const nearby = (types: string[], radius: number, exclude: string[] = []) =>
      google('/places:searchNearby', { includedTypes: types, excludedTypes: exclude, maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: circle(radius) }, PLACE_FIELDS);
    const text = (q: string, radius: number) =>
      google('/places:searchText', { textQuery: q, pageSize: 15, locationBias: circle(radius) }, PLACE_FIELDS);

    const settle = async (p: Promise<any>) => { try { return { ok: true, data: await p }; } catch { return { ok: false, data: null }; } };

    const [hospitals, trauma, ambulance, chemists, doctors] = await Promise.all([
      settle(nearby(['hospital'], 6000, ['dental_clinic', 'dentist'])),
      settle(text('trauma centre emergency hospital', 15000)),
      settle(text('ambulance service', 15000)),
      settle(nearby(['pharmacy', 'drugstore'], 3000)),
      settle(query(
        `SELECT d.id, u.full_name, d.medical_system, d.specialization, d.degree, d.experience_years, d.city, d.avg_rating, d.total_reviews,
                MIN(cf.fee_amount) AS min_fee
         FROM doctors d JOIN users u ON u.id = d.user_id
         LEFT JOIN consultation_fees cf ON cf.doctor_id = d.id
         WHERE u.is_active = TRUE AND d.profile_status = 'verified'
           AND ($1 = '' OR d.city ILIKE '%' || $1 || '%')
           AND COALESCE(d.specialization,'') !~* '(dent|orthodont|endodont|oral)'
           AND COALESCE(d.degree,'') !~* '(BDS|MDS)'
         GROUP BY d.id, u.full_name
         ORDER BY d.avg_rating DESC NULLS LAST LIMIT 50`, [city])),
    ]);

    if (!hospitals.ok && !trauma.ok && !ambulance.ok && !chemists.ok) throw new AppError(502, 'MAPS_ERROR', 'Could not load places right now.');

    sendSuccess(res, {
      emergency_numbers: EMERGENCY[country] || [{ label: 'Emergency', number: '112' }],
      hospitals: hospitals.ok ? shape(hospitals.data.places, center) : null,
      trauma_centres: trauma.ok ? shape(trauma.data.places, center).filter(p => p.distance_km == null || p.distance_km <= 25) : null,
      ambulances: ambulance.ok ? shape(ambulance.data.places, center).filter(p => p.distance_km == null || p.distance_km <= 25) : null,
      chemists: chemists.ok ? shape(chemists.data.places, center) : null,
      doctors: doctors.ok ? doctors.data : [],
      attribution: 'Places data © Google',
    });
  } catch (e) { next(e); }
});

export default router;
