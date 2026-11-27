import { z } from 'zod';

export const passwordRules = [
    { id: 'length', label: '8-20 characters', minimum: 8, maximum: 20, message: 'Password must be 8-20 characters' },
    { id: 'uppercase', label: 'At least one uppercase letter (A-Z)', pattern: /[A-Z]/, message: 'Must contain an uppercase letter' },
    { id: 'lowercase', label: 'At least one lowercase letter (a-z)', pattern: /[a-z]/, message: 'Must contain a lowercase letter' },
    { id: 'number', label: 'At least one number (0-9)', pattern: /[0-9]/, message: 'Must contain a number' },
    { id: 'special', label: 'At least one special character', pattern: /[!@#$%^&*(),.?":{}|<>]/, message: 'Must contain a special character' },
];

export const passwordSchema = passwordRules.reduce(
    (schema, rule) => rule.pattern
        ? schema.regex(rule.pattern, rule.message)
        : schema.refine((value) => Array.from(value).length >= rule.minimum && Array.from(value).length <= rule.maximum, rule.message),
    z.string()
);

export function getPasswordRequirements(password = '') {
    return passwordRules.map((rule) => ({
        id: rule.id,
        label: rule.label,
        met: rule.pattern ? rule.pattern.test(password) : Array.from(password).length >= rule.minimum && Array.from(password).length <= rule.maximum,
    }));
}
