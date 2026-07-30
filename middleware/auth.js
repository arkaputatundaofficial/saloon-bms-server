const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const globalSupabase = require('../supabaseClient');

const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];

    // Verify user by getting user object
    const { data: { user }, error } = await globalSupabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = user;
    req.supabase = globalSupabase; // attach global client

    // Fetch user role from profiles
    const { data: profile, error: profileError } = await globalSupabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

    if (profileError || !profile) {
        req.role = null; 
    } else {
        req.role = profile.role;
    }

    next();
};

const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.role || !roles.includes(req.role)) {
            return res.status(403).json({ error: 'Forbidden: Insufficient role' });
        }
        next();
    };
};

module.exports = { authenticate, requireRole };
