"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../../middleware/authenticate");
const authorize_1 = require("../../middleware/authorize");
const database_1 = require("../../config/database");
const apiResponse_1 = require("../../utils/apiResponse");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
// Get all legal pages (public)
router.get('/', async (req, res, next) => {
    try {
        const pages = await (0, database_1.query)('SELECT id, slug, title, category, updated_at FROM legal_pages WHERE is_published=TRUE ORDER BY category, sort_order', []);
        (0, apiResponse_1.sendSuccess)(res, pages);
    }
    catch (e) {
        next(e);
    }
});
// Get single page by slug (public)
router.get('/:slug', async (req, res, next) => {
    try {
        const page = await (0, database_1.queryOne)('SELECT * FROM legal_pages WHERE slug=$1 AND is_published=TRUE', [req.params.slug]);
        if (!page)
            throw new errorHandler_1.AppError(404, 'NOT_FOUND', 'Page not found.');
        (0, apiResponse_1.sendSuccess)(res, page);
    }
    catch (e) {
        next(e);
    }
});
// Admin: get all pages including drafts
router.get('/admin/all', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const pages = await (0, database_1.query)('SELECT * FROM legal_pages ORDER BY category, sort_order', []);
        (0, apiResponse_1.sendSuccess)(res, pages);
    }
    catch (e) {
        next(e);
    }
});
// Admin: create or update page
router.post('/', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        const { slug, title, category, content, is_published, sort_order } = req.body;
        if (!slug || !title || !content)
            throw new errorHandler_1.AppError(400, 'MISSING_FIELDS', 'slug, title and content required.');
        const existing = await (0, database_1.queryOne)('SELECT id FROM legal_pages WHERE slug=$1', [slug]);
        let page;
        if (existing) {
            [page] = await (0, database_1.query)(`UPDATE legal_pages SET title=$1, category=$2, content=$3, is_published=$4, sort_order=$5, updated_at=NOW()
         WHERE slug=$6 RETURNING *`, [title, category || 'public', content, is_published ?? true, sort_order || 0, slug]);
        }
        else {
            [page] = await (0, database_1.query)(`INSERT INTO legal_pages (slug, title, category, content, is_published, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [slug, title, category || 'public', content, is_published ?? true, sort_order || 0]);
        }
        (0, apiResponse_1.sendCreated)(res, page);
    }
    catch (e) {
        next(e);
    }
});
// Admin: delete page
router.delete('/:slug', authenticate_1.authenticate, (0, authorize_1.authorize)('admin'), async (req, res, next) => {
    try {
        await (0, database_1.query)('DELETE FROM legal_pages WHERE slug=$1', [req.params.slug]);
        (0, apiResponse_1.sendSuccess)(res, { message: 'Page deleted.' });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=legal.routes.js.map