import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { query, queryOne } from '../../config/database';
import { sendSuccess, sendCreated } from '../../utils/apiResponse';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

// Get all legal pages (public)
router.get('/', async (req, res, next) => {
  try {
    const pages = await query(
      'SELECT id, slug, title, category, updated_at FROM legal_pages WHERE is_published=TRUE ORDER BY category, sort_order',
      []
    );
    sendSuccess(res, pages);
  } catch (e) { next(e); }
});

// Get single page by slug (public)
router.get('/:slug', async (req, res, next) => {
  try {
    const page = await queryOne(
      'SELECT * FROM legal_pages WHERE slug=$1 AND is_published=TRUE',
      [req.params.slug]
    );
    if (!page) throw new AppError(404, 'NOT_FOUND', 'Page not found.');
    sendSuccess(res, page);
  } catch (e) { next(e); }
});

// Admin: get all pages including drafts
router.get('/admin/all', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const pages = await query(
      'SELECT * FROM legal_pages ORDER BY category, sort_order',
      []
    );
    sendSuccess(res, pages);
  } catch (e) { next(e); }
});

// Admin: create or update page
router.post('/', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { slug, title, category, content, is_published, sort_order } = req.body;
    if (!slug || !title || !content) throw new AppError(400, 'MISSING_FIELDS', 'slug, title and content required.');

    const existing = await queryOne<{ id: string }>('SELECT id FROM legal_pages WHERE slug=$1', [slug]);
    let page;
    if (existing) {
      [page] = await query(
        `UPDATE legal_pages SET title=$1, category=$2, content=$3, is_published=$4, sort_order=$5, updated_at=NOW()
         WHERE slug=$6 RETURNING *`,
        [title, category || 'public', content, is_published ?? true, sort_order || 0, slug]
      ) as any[];
    } else {
      [page] = await query(
        `INSERT INTO legal_pages (slug, title, category, content, is_published, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [slug, title, category || 'public', content, is_published ?? true, sort_order || 0]
      ) as any[];
    }
    sendCreated(res, page);
  } catch (e) { next(e); }
});

// Admin: delete page
router.delete('/:slug', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM legal_pages WHERE slug=$1', [req.params.slug]);
    sendSuccess(res, { message: 'Page deleted.' });
  } catch (e) { next(e); }
});

export default router;
