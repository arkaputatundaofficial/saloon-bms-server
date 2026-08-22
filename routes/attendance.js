const express = require('express');
const router = express.Router();
const supabase = require('../supabaseClient');
const { authenticate, requireRole } = require('../middleware/auth');

// Helper to format dates as dd/mm/yyyy
function formatDate(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

// Helper to format dates as yyyy-mm-dd
function formatDateISO(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${year}-${month}-${day}`;
}

// POST /api/attendance/mark
// Public endpoint to check in / check out using profile's uid
router.post('/mark', async (req, res) => {
    const { uid } = req.body;
    if (!uid) {
        return res.status(400).json({ error: "Missing uid parameter" });
    }

    try {
        // Find matching profile
        const { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('id, uid')
            .eq('uid', uid)
            .single();

        if (profileErr || !profile) {
            return res.status(404).json({ error: "Profile not found for the given uid" });
        }

        // Get daily attendance record
        let { data: row, error: fetchErr } = await supabase
            .from('daily_attendance')
            .select('*')
            .eq('profile', profile.id)
            .maybeSingle();

        const now = new Date();

        if (!row) {
            // Checkin: Create new record
            const { data: newRow, error: insertErr } = await supabase
                .from('daily_attendance')
                .insert([{
                    profile: profile.id,
                    arrived_at: now.toISOString(),
                    departed_at: null,
                    present: false
                }])
                .select()
                .single();

            if (insertErr) throw insertErr;
            return res.json({ success: true, event: "checkin", data: newRow });
        }

        // Record exists, check checkout condition
        const arrivedAtDate = row.arrived_at ? new Date(row.arrived_at) : null;
        const isSameDay = arrivedAtDate &&
            arrivedAtDate.getFullYear() === now.getFullYear() &&
            arrivedAtDate.getMonth() === now.getMonth() &&
            arrivedAtDate.getDate() === now.getDate();

        if (row.present === true && isSameDay) {
            return res.status(400).json({ error: "Attendance already complete. User has already checked out for today." });
        }

        if (row.present === false && row.arrived_at !== null && isSameDay) {
            // Checkout: Add departed_at and mark present as true
            const { data: updatedRow, error: updateErr } = await supabase
                .from('daily_attendance')
                .update({
                    departed_at: now.toISOString(),
                    present: true
                })
                .eq('profile', profile.id)
                .select()
                .single();

            if (updateErr) throw updateErr;
            return res.json({ success: true, event: "checkout", data: updatedRow });
        } else {
            // Checkin/Reset: Clear existing fields, set arrived_at and present to false
            const { data: updatedRow, error: updateErr } = await supabase
                .from('daily_attendance')
                .update({
                    arrived_at: now.toISOString(),
                    departed_at: null,
                    present: false
                })
                .eq('profile', profile.id)
                .select()
                .single();

            if (updateErr) throw updateErr;
            return res.json({ success: true, event: "checkin", data: updatedRow });
        }
    } catch (err) {
        console.error("Mark Attendance Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/attendance/employees
// Fetch all profiles for the admin directory list (Admin only)
router.get('/employees', authenticate, requireRole('admin'), async (req, res) => {
    try {
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('id, email, full_name, role, uid')
            .order('full_name', { ascending: true });

        if (error) throw error;
        res.json(profiles);
    } catch (err) {
        console.error("Fetch Employees Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/attendance/user/:userId/week
// Fetch present dates for the current week (Monday - Sunday) for a user (Admin only)
router.get('/user/:userId/week', authenticate, requireRole('admin'), async (req, res) => {
    const { userId } = req.params;

    try {
        // Get user's daily attendance row and serial ID
        const { data: daRow, error: daErr } = await supabase
            .from('daily_attendance')
            .select('id, present, arrived_at')
            .eq('profile', userId)
            .maybeSingle();

        if (daErr) throw daErr;

        const presentDatesSet = new Set();
        
        // If we found a daily attendance serial ID, calculate current week
        if (daRow) {
            const today = new Date();
            const currentDay = today.getDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
            const distanceToMonday = currentDay === 0 ? -6 : 1 - currentDay;
            const monday = new Date(today);
            monday.setDate(today.getDate() + distanceToMonday);
            monday.setHours(0, 0, 0, 0);

            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            sunday.setHours(23, 59, 59, 999);

            // Construct 7 week dates strings
            const dbDateStrings = [];
            for (let i = 0; i < 7; i++) {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                dbDateStrings.push(formatDate(d));
            }

            // Query year_attendance matching these dates
            const { data: records, error: yearErr } = await supabase
                .from('year_attendance')
                .select('*')
                .in('date', dbDateStrings);

            if (yearErr) throw yearErr;

            (records || []).forEach(rec => {
                if (rec.attendance && rec.attendance.includes(Number(daRow.id))) {
                    const parts = rec.date.split('/');
                    presentDatesSet.add(`${parts[2]}-${parts[1]}-${parts[0]}`); // yyyy-mm-dd
                }
            });

            // Check if today is marked as present in daily_attendance
            if (daRow.present === true && daRow.arrived_at) {
                const arrivedDate = new Date(daRow.arrived_at);
                if (arrivedDate >= monday && arrivedDate <= sunday) {
                    presentDatesSet.add(formatDateISO(arrivedDate));
                }
            }
        }

        res.json(Array.from(presentDatesSet));
    } catch (err) {
        console.error("Fetch Weekly Attendance Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/attendance/user/:userId/history
// Fetch present dates for the current year for a user (Admin only)
router.get('/user/:userId/history', authenticate, requireRole('admin'), async (req, res) => {
    const { userId } = req.params;

    try {
        // Get user's daily attendance row and serial ID
        const { data: daRow, error: daErr } = await supabase
            .from('daily_attendance')
            .select('id, present, arrived_at')
            .eq('profile', userId)
            .maybeSingle();

        if (daErr) throw daErr;

        const presentDatesSet = new Set();

        if (daRow) {
            const currentYear = new Date().getFullYear();
            
            // Query year_attendance for the current year
            const { data: records, error: yearErr } = await supabase
                .from('year_attendance')
                .select('*')
                .like('date', `%/${currentYear}`);

            if (yearErr) throw yearErr;

            (records || []).forEach(rec => {
                if (rec.attendance && rec.attendance.includes(Number(daRow.id))) {
                    const parts = rec.date.split('/');
                    presentDatesSet.add(`${parts[2]}-${parts[1]}-${parts[0]}`); // yyyy-mm-dd
                }
            });

            // Check today's status
            if (daRow.present === true && daRow.arrived_at) {
                const arrivedDate = new Date(daRow.arrived_at);
                if (arrivedDate.getFullYear() === currentYear) {
                    presentDatesSet.add(formatDateISO(arrivedDate));
                }
            }
        }

        res.json(Array.from(presentDatesSet));
    } catch (err) {
        console.error("Fetch History Attendance Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// POST / GET /api/attendance/cron-trigger
// Scheduled trigger endpoint for the daily midnight rollover
const rolloverHandler = async (req, res) => {
    try {
        const result = await runDailyRolloverInternal();
        res.json({ success: true, message: "Rollover executed successfully", ...result });
    } catch (err) {
        console.error("Cron Trigger Rollover Error:", err);
        res.status(500).json({ error: err.message });
    }
};

router.post('/cron-trigger', rolloverHandler);
router.get('/cron-trigger', rolloverHandler);

// Daily rollover helper function
async function runDailyRolloverInternal() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = formatDate(yesterday);

    console.log(`Running daily attendance rollover for date: ${dateStr}`);

    // Check if this date already exists in year_attendance
    const { data: existing, error: existErr } = await supabase
        .from('year_attendance')
        .select('serial_no')
        .eq('date', dateStr)
        .maybeSingle();

    if (existErr) throw existErr;

    if (existing) {
        return { skipped: true, reason: `Rollover already executed for ${dateStr}` };
    }

    // Fetch all present rows from daily_attendance
    const { data: presentRows, error: fetchErr } = await supabase
        .from('daily_attendance')
        .select('id')
        .eq('present', true);

    if (fetchErr) throw fetchErr;

    const presentIds = (presentRows || []).map(row => Number(row.id));

    // Insert new row into year_attendance
    const { error: insertErr } = await supabase
        .from('year_attendance')
        .insert([{
            date: dateStr,
            attendance: presentIds
        }]);

    if (insertErr) throw insertErr;

    console.log(`Archived ${presentIds.length} present employees in year_attendance for ${dateStr}.`);

    // Check end-of-year archiving (yesterday was Dec 31st)
    if (yesterday.getMonth() === 11 && yesterday.getDate() === 31) {
        await archiveYearToSupabaseBucketInternal(yesterday.getFullYear());
    }

    // Reset daily_attendance: set all fields to null
    const { error: resetErr } = await supabase
        .from('daily_attendance')
        .update({
            arrived_at: null,
            departed_at: null,
            present: null
        })
        .neq('id', 0); // Updates all rows

    if (resetErr) {
        console.error("Failed to reset daily_attendance table:", resetErr.message);
    }

    return { skipped: false, date: dateStr, attendeesCount: presentIds.length };
}

// End-of-year archiving helper function
async function archiveYearToSupabaseBucketInternal(year) {
    console.log(`Starting year-end archiving for ${year}...`);

    // Fetch all year_attendance rows
    const { data: records, error: fetchErr } = await supabase
        .from('year_attendance')
        .select('*');

    if (fetchErr) throw fetchErr;

    // Fetch daily_attendance joined with profiles to build a mapping of serial id -> profile uid
    const { data: attendanceMapping, error: mapErr } = await supabase
        .from('daily_attendance')
        .select(`
            id,
            profiles ( uid )
        `);

    if (mapErr) throw mapErr;

    const idToUidMap = {};
    (attendanceMapping || []).forEach(row => {
        if (row.profiles && row.profiles.uid) {
            idToUidMap[row.id] = row.profiles.uid;
        }
    });

    // Format records for JSON output
    const jsonRecords = (records || []).map(rec => {
        const parts = rec.date.split('/');
        const formattedDate = `${parts[2]}-${parts[1]}-${parts[0]}`; // yyyy-mm-dd
        const attendees = (rec.attendance || []).map(id => idToUidMap[id] || `unknown_${id}`);

        return {
            date: formattedDate,
            attendees: attendees
        };
    });

    const archiveData = {
        year: year,
        records: jsonRecords
    };

    const jsonString = JSON.stringify(archiveData, null, 2);

    // List buckets and create 'attendance' if it doesn't exist
    const { data: buckets, error: listErr } = await supabase.storage.listBuckets();
    if (listErr) throw listErr;

    if (!buckets.find(b => b.name === 'attendance')) {
        console.log("Bucket 'attendance' not found. Creating it...");
        const { error: createErr } = await supabase.storage.createBucket('attendance', { public: true });
        if (createErr) throw createErr;
    }

    // Upload JSON files
    const path1 = `${year}.json`;
    const path2 = `${year}.json/${year}.json`;

    const uploadOptions = {
        contentType: 'application/json',
        upsert: true
    };

    // Upload to 'attendance/YYYY.json'
    const { error: uploadErr1 } = await supabase.storage
        .from('attendance')
        .upload(path1, Buffer.from(jsonString), uploadOptions);

    if (uploadErr1) console.error(`Failed to upload to path1 ${path1}:`, uploadErr1.message);

    // Upload to 'attendance/YYYY.json/YYYY.json'
    const { error: uploadErr2 } = await supabase.storage
        .from('attendance')
        .upload(path2, Buffer.from(jsonString), uploadOptions);

    if (uploadErr2) console.error(`Failed to upload to path2 ${path2}:`, uploadErr2.message);

    console.log(`Uploaded year ${year} archive data to Supabase storage successfully.`);

    // Clear year_attendance table for the new year
    const { error: clearErr } = await supabase
        .from('year_attendance')
        .delete()
        .gte('serial_no', 0);

    if (clearErr) {
        console.error("Failed to clear year_attendance table:", clearErr.message);
    }
}

module.exports = {
    router,
    runDailyRolloverInternal
};
