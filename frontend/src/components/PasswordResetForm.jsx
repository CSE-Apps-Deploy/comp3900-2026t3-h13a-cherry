'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import NewPasswordFields from './NewPasswordFields';
import { registerSchema } from '../lib/register-form';
import { passwordResetApi } from '../lib/api-services/sprint1';

const resetSchema = z
    .object({
        password: registerSchema.shape.password,
        confirmPassword: z.string().min(1, 'Please confirm your password'),
    })
    .refine((data) => data.password === data.confirmPassword, {
        message: "Passwords don't match",
        path: ['confirmPassword'],
    });

export default function PasswordResetForm() {
    const params = useSearchParams();
    const token = params.get('token') || '';
    const [checking, setChecking] = useState(true);
    const [error, setError] = useState('');
    const [complete, setComplete] = useState(false);
    const [saving, setSaving] = useState(false);
    const {
        register,
        handleSubmit,
        watch,
        formState: { errors },
    } = useForm({ resolver: zodResolver(resetSchema) });
    useEffect(() => {
        let cancelled = false;
        setChecking(true);
        setError('');
        if (!/^[a-f0-9]{64}$/i.test(token)) {
            setError('This reset link is invalid. Request a new link.');
            setChecking(false);
            return;
        }
        passwordResetApi
            .validate(token)
            .catch((failure) => {
                if (!cancelled)
                    setError(
                        failure?.response?.data?.message ||
                            'Unable to verify this reset link. Please try again.'
                    );
            })
            .finally(() => {
                if (!cancelled) setChecking(false);
            });
        return () => {
            cancelled = true;
        };
    }, [token]);
    const onSubmit = async (values) => {
        setSaving(true);
        try {
            await passwordResetApi.reset({ token, ...values });
            setComplete(true);
        } catch (failure) {
            setError(
                failure?.response?.data?.message ||
                    'Unable to reset your password. Please try again.'
            );
        } finally {
            setSaving(false);
        }
    };
    if (checking) return <p className="text-sm text-gray-500">Checking reset link...</p>;
    if (complete)
        return (
            <div className="space-y-4">
                <p role="status" className="text-sm text-emerald-700">
                    Password reset successfully. Sign in with your new password.
                </p>
                <Link href="/login" className="btn-primary">
                    Go to login
                </Link>
            </div>
        );
    if (error)
        return (
            <div className="space-y-4">
                <p role="alert" className="error-text">
                    {error}
                </p>
                <Link href="/forgot-password" className="btn-primary">
                    Request a new link
                </Link>
            </div>
        );
    return (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <NewPasswordFields
                register={register}
                watch={watch}
                errors={errors}
                idPrefix="reset"
            />
            <button
                type="submit"
                disabled={saving}
                className="btn-primary btn-lg w-full justify-center rounded-2xl"
            >
                {saving ? 'Resetting...' : 'Reset password'}
            </button>
        </form>
    );
}
