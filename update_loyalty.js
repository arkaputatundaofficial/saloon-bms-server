require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET
);

async function updateLoyaltyRules() {
  console.log("Updating loyalty rules...");
  
  // Upsert the tiers
  const rules = [
    { tier: 'regular', discount_percent: 0 },
    { tier: 'silver', discount_percent: 5 },
    { tier: 'gold', discount_percent: 6 },
    { tier: 'platinum', discount_percent: 10 }
  ];

  const { data, error } = await supabase
    .from('loyalty_rules')
    .upsert(rules, { onConflict: 'tier' })
    .select();

  if (error) {
    console.error("Error updating rules:", error);
  } else {
    console.log("Updated rules successfully:", data);
  }
}

updateLoyaltyRules();
