const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.split(' ')[1];

    // Create a request-scoped Supabase client carrying the user's JWT
    // so RLS is enforced automatically on every query made with this client
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY,
        {
            global: {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            }
        }
    );

    // Verify user by getting user object
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = user;
    req.supabase = supabase; // attach scoped client

    // Fetch user role from profiles
    const { data: profile, error: profileError } = await supabase
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
