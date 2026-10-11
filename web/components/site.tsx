'use client';
import { createContext, useContext } from 'react';

interface Site { id: number; name: string; timezone: string }
const Ctx = createContext<Site>({ id: 1, name: '', timezone: 'UTC' });
export const SiteProvider = Ctx.Provider;
export const useSite = () => useContext(Ctx);
