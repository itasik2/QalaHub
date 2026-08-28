const apiBase = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:4000/api/v1';

const response = await fetch(`${apiBase}/supply-health/pavlodar`);
if (!response.ok) {
  throw new Error(`Supply health request failed: ${response.status} ${await response.text()}`);
}

const health = await response.json();
const electricalNeed = health.recruitmentNeeds?.find(
  (need) => need.categorySlug === 'electrical',
);

if (!electricalNeed) {
  throw new Error(`Persistent electrical recruitment need missing: ${JSON.stringify(health.recruitmentNeeds)}`);
}
if (electricalNeed.status !== 'OPEN') {
  throw new Error(`Electrical recruitment need must be OPEN, got ${electricalNeed.status}`);
}
if (electricalNeed.priorityScore <= 0 || electricalNeed.supplyGap <= 0) {
  throw new Error(`Electrical recruitment need priority is invalid: ${JSON.stringify(electricalNeed)}`);
}

console.log('SMOKE_SUPPLY_NEEDS_OK', {
  needId: electricalNeed.id,
  category: electricalNeed.categorySlug,
  status: electricalNeed.status,
  health: electricalNeed.health,
  supplyGap: electricalNeed.supplyGap,
  requests7d: electricalNeed.requests7d,
  priorityScore: electricalNeed.priorityScore,
});
