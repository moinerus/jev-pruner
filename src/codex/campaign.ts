import { JevDurableCampaignAllowance } from './durable-campaign-allowance.js';

export function campaignFromEnvironment(env: NodeJS.ProcessEnv): {
  required: boolean;
  allowance?: JevDurableCampaignAllowance;
} {
  const values = [
    env.JEV_PRUNER_CAMPAIGN_LEDGER,
    env.JEV_PRUNER_CAMPAIGN_MAX_REQUESTS,
    env.JEV_PRUNER_CAMPAIGN_MAX_RESERVED_MICRO_USD,
    env.JEV_PRUNER_CAMPAIGN_PER_REQUEST_CEILING_MICRO_USD,
  ];
  if (values.every(value => value === undefined)) return { required: false };
  try {
    if (values.some(value => !value)) return { required: true };
    return { required: true, allowance: new JevDurableCampaignAllowance(
      values[0]!, Number(values[1]), Number(values[2]), Number(values[3]),
    ) };
  } catch { return { required: true }; }
}
