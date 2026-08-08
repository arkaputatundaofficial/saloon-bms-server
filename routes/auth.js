const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authenticate } = require('../middleware/auth');
const router = express.Router();
const supabase = require('../supabaseClient');
const emailjs = require('@emailjs/nodejs');

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        return res.status(401).json({ error: error.message });
    }

    const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        .single();

    res.json({
        ...data,
        user: {
            ...data.user,
            role: profile?.role || null
        }
    });
});

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
    const { email, password, full_name, role } = req.body;
    
    const { data, error } = await supabase.auth.signUp({
        email,
        password
    });

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    // Attempt to insert profile. Note: Requires RLS insert policy on profiles or service role key
    if (data.user) {
        try {
            const { error: profileError } = await supabase
                .from('profiles')
                .insert([{
                    id: data.user.id,
                    full_name: full_name || '',
                    role: role || 'employee'
                }]);
                
            if (profileError) {
                console.error("Profile creation error:", profileError.message);
            }
        } catch (err) {
            console.error("Failed to initialize admin client:", err.message);
        }
    }

    res.json({ success: true, user: data.user });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        // For MVP, signing out the token locally or on Supabase.
        // The client supabase instance is required to do this properly
        // but frontend dropping the token is sufficient for this scope.
    }
    res.json({ success: true });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    // Check if user exists
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    
    if (error) {
        return res.status(500).json({ error: error.message });
    }
    
    const user = users.find(u => u.email === email);
    if (!user) {
        return res.status(404).json({ error: "User with this email not found." });
    }
    
    // Clean up expired OTPs (older than 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await supabase.from('otps').delete().lt('created_at', fiveMinutesAgo);

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    
    // Upsert into Supabase otps table
    const { error: otpError } = await supabase
        .from('otps')
        .upsert([{ email, otp, created_at: new Date().toISOString() }]);

    if (otpError) {
        console.error("Supabase OTP Error:", otpError);
        return res.status(500).json({ error: "Failed to store OTP." });
    }
    
    try {
        await emailjs.send(
            process.env.EMAILJS_SERVICE_ID,
            process.env.EMAILJS_TEMPLATE_ID,
            {
                email: email,
                otp: otp
            },
            {
                publicKey: process.env.EMAILJS_PUBLIC_KEY,
                privateKey: process.env.EMAILJS_PRIVATE_KEY
            }
        );
        res.json({ success: true, message: "OTP sent to email." });
    } catch (err) {
        console.error("EmailJS Error:", err);
        res.status(500).json({ error: "Failed to send OTP email." });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    
    // Query OTP from Supabase
    const { data: otpData, error: otpError } = await supabase
        .from('otps')
        .select('*')
        .eq('email', email)
        .single();
        
    if (otpError || !otpData) {
        return res.status(400).json({ error: "Invalid OTP or email." });
    }
    
    // Check expiration
    const createdAt = new Date(otpData.created_at).getTime();
    if (Date.now() - createdAt > 5 * 60 * 1000) {
        // Delete expired OTP
        await supabase.from('otps').delete().eq('email', email);
        return res.status(400).json({ error: "OTP has expired." });
    }
    
    // Check if OTP matches
    if (otpData.otp !== otp) {
        return res.status(400).json({ error: "Invalid OTP." });
    }
    
    // OTP is valid, delete it
    await supabase.from('otps').delete().eq('email', email);
    
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    
    if (error) {
        return res.status(500).json({ error: error.message });
    }
    
    const user = users.find(u => u.email === email);
    if (!user) {
        return res.status(404).json({ error: "User not found." });
    }
    
    const { error: updateError } = await supabase.auth.admin.updateUserById(
        user.id,
        { password: newPassword }
    );
    
    if (updateError) {
        return res.status(500).json({ error: updateError.message });
    }
    
    res.json({ success: true, message: "Password updated successfully." });
});

// GET /api/auth/profile
router.get('/profile', authenticate, async (req, res) => {
    try {
        const { data, error } = await req.supabase
            .from('profiles')
            .select('*')
            .eq('id', req.user.id)
            .single();

        if (error && error.code !== 'PGRST116') throw error;
        
        res.json({
            ...req.user,
            profile: data || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/auth/account
router.delete('/account', authenticate, async (req, res) => {
    try {
        if (!process.env.SUPABASE_SECRET) {
            return res.status(500).json({ error: "Server missing SUPABASE_SECRET to perform account deletion." });
        }
        
        // Use global admin key to delete user from Auth
        const { error } = await supabase.auth.admin.deleteUser(req.user.id);
        
        if (error) {
            throw error;
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
