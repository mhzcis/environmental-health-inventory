import { getCurrentAuthUser, isSupabaseConfigured, supabase, secondarySupabase } from './supabase';

const auth = {
  get currentUser() {
    return getCurrentAuthUser();
  },
};

const secondaryAuth = {
  get currentUser() {
    return null;
  },
};

const app = supabase;
const db = supabase;
const isFirebaseAvailable = isSupabaseConfigured();
const firebaseConfig = {};

export { app, db, auth, secondaryAuth, isFirebaseAvailable, firebaseConfig };
