const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const globalSupabase = require('../supabaseClient');

const authenticate = async (req, res, next) => {
    const userId = req.headers['x-user-id'];
    
    if (!userId) {
        return res.status(401).json({ error: 'Missing X-User-Id header' });
    }

    req.supabase = globalSupabase; // attach global client

    // Fetch user profile based on ID
    const { data: profile, error: profileError } = await globalSupabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

    if (profileError || !profile) {
        return res.status(401).json({ error: 'Unauthorized: User not found' });
    }

    req.user = { id: userId, ...profile };
    req.role = profile.role || null; 

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
