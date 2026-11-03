/** Fictional settings shared by the standalone memory reviewer tests. */
export const DEFAULT_TEST_SETTINGS={
  name:'Test companion',persona:'Fictional companion used only by offline tests.',
  provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'test-model',
  maintenanceMode:'auto' as 'off'|'preview'|'auto',candidateBudget:24,minimumSimilarity:.55,
  reviewMaxDelaySeconds:60,dailyMaintenanceCalls:8,dailyInputTokens:40000,dailyOutputTokens:6000,
  memoryContextTokens:600,detailRetentionDays:30,idleReviewSeconds:15,
};
