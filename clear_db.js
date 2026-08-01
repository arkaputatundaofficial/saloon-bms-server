const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET
);

async function clearDB() {
    console.log("Starting DB clear...");

    const tables = [
        "invoice_items",
        "invoices",
        "customers",
        "loyalty_rules",
        "products",
        "services",
        "profiles"
    ];

    for (const table of tables) {
        console.log(`Clearing table: ${table}...`);
        
        // We'll delete all rows that have a created_at >= 1970 (which is all of them)
        const { data, error } = await supabase
            .from(table)
            .delete()
            .gte('created_at', '1970-01-01T00:00:00Z');
            
        if (error) {
            console.error(`Error deleting from ${table}:`, error.message);
            // Fallback for tables without created_at (like invoice_items maybe)
            console.log(`Attempting fallback clear for ${table}...`);
            const { data: fetchAll, error: fetchErr } = await supabase.from(table).select("*");
            if (!fetchErr && fetchAll && fetchAll.length > 0) {
                for (const row of fetchAll) {
                    if (row.id) {
                        await supabase.from(table).delete().eq('id', row.id);
                    } else if (row.invoice_id && row.item_id) {
                        await supabase.from(table).delete().eq('invoice_id', row.invoice_id).eq('item_id', row.item_id);
                    }
                }
                console.log(`Fallback clear complete for ${table}.`);
            }
        } else {
            console.log(`Cleared ${table} using created_at.`);
        }
    }

    console.log("Clearing auth users...");
    let hasMoreUsers = true;
    let page = 1;
    while (hasMoreUsers) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) {
            console.error("Error fetching users:", error);
            break;
        }
        if (!data.users || data.users.length === 0) {
            hasMoreUsers = false;
            break;
        }
        for (const user of data.users) {
            const { error: delUserError } = await supabase.auth.admin.deleteUser(user.id);
            if (delUserError) {
                console.error(`Error deleting user ${user.id}:`, delUserError);
            } else {
                console.log(`Deleted user ${user.email}`);
            }
        }
        // Since we are deleting, page 1 will keep having the next set if there were > 1000
        // No need to increment page.
    }

    console.log("Database cleared successfully!");
}

clearDB();
