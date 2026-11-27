'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { registerSchema } from '../../../lib/register-form';
import { passwordResetApi } from '../../../lib/api-services/sprint1';

const requestSchema = z.object({ email: registerSchema.shape.email });

export default function ForgotPasswordPage() {
    const [pendingUntil, setPendingUntil] = useState(null);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm({ resolver: zodResolver(requestSchema) });
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const onSubmit = async ({ email }) => {
        setSaving(true);
        setError('');
        try {
            const response = await passwordResetApi.request(email);
            setMessage(response.data.message);
            setPendingUntil(Date.now() + Number(response.data.data.expiresInMinutes) * 60000);
            setNow(Date.now());
        } catch (failure) {
            setError(
                failure?.response?.data?.message ||
                    'Unable to request a reset link. Please try again.'
            );
        } finally {
            setSaving(false);
        }
    };
    const remaining = pendingUntil ? Math.max(0, Math.ceil((pendingUntil - now) / 60000)) : 0;
    return (
        <div className="min-h-screen bg-white px-6 py-12">
            <div className="mx-auto max-w-md space-y-6">
                <Link href="/login" className="text-sm text-gray-500">
                    ← Back to login
                </Link>
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Forgot your password?</h1>
                    <p className="mt-2 text-sm text-gray-500">
                        Enter your registered email to request a reset link.
                    </p>
                </div>
                {error && (
                    <p role="alert" className="error-text">
                        {error}
                    </p>
                )}
                {pendingUntil && (
                    <div
                        role="status"
                        className="rounded-xl border border-primary-200 bg-primary-50 p-4 space-y-2 text-sm text-primary-800"
                    >
                        <p>{message}</p>
                        <p>
                            {remaining > 0
                                ? `Pending: check your email. The link expires in ${remaining} minutes.`
                                : 'The pending reset link has expired. Request a new link below.'}
                        </p>
                    </div>
                )}
                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                    <div>
                        <label htmlFor="reset-email" className="label">
                            Email
                        </label>
                        <input
                            id="reset-email"
                            {...register('email')}
                            type="email"
                            autoComplete="email"
                            className="input"
                            placeholder="you@example.com"
                        />
                        {errors.email && <p className="error-text">{errors.email.message}</p>}
                    </div>
                    <button
                        type="submit"
                        disabled={saving}
                        className="btn-primary btn-lg w-full justify-center rounded-2xl"
                    >
                        {saving
                            ? 'Sending...'
                            : pendingUntil
                              ? 'Request another link'
                              : 'Send reset link'}
                    </button>
                </form>
            </div>
        </div>
    );
}
