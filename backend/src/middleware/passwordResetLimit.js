const { AppError } = require('./errorHandler');

const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

function passwordResetLimit(req, res, next) {
    const now = Date.now();
    for (const [key, entry] of attempts) {
        if (entry.expiresAt <= now) attempts.delete(key);
    }
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const keys = [[`ip:${req.ip || 'unknown'}`, 40]];
    if (email) keys.push([`email:${email}`, 5]);
    for (const [key, limit] of keys) {
        const current = attempts.get(key);
        if ((current && current.count >= limit) || (!current && attempts.size >= 10000)) {
            res.set(
                'Retry-After',
                String(Math.ceil(((current?.expiresAt || now + WINDOW_MS) - now) / 1000))
            );
            return next(
                new AppError('Too many password reset attempts. Please try again later.', 429)
            );
        }
    }
    for (const [key] of keys) {
        const current = attempts.get(key) || { count: 0, expiresAt: now + WINDOW_MS };
        current.count += 1;
        attempts.set(key, current);
    }
    next();
}

module.exports = { passwordResetLimit };
