// services/stamp-duty-calculator.js

export function calculateStampDuty(input) {
  const { propertyValue, state, isFirstHomeBuyer } = input;
  
  // Basic QLD stamp duty calculation (simplified)
  let stampDuty = 0;
  
  if (state === 'QLD') {
    if (propertyValue <= 5000) {
      stampDuty = 0;
    } else if (propertyValue <= 75000) {
      stampDuty = (propertyValue - 5000) * 0.015;
    } else if (propertyValue <= 540000) {
      stampDuty = 1050 + (propertyValue - 75000) * 0.035;
    } else if (propertyValue <= 1000000) {
      stampDuty = 17325 + (propertyValue - 540000) * 0.045;
    } else {
      stampDuty = 38025 + (propertyValue - 1000000) * 0.0575;
    }
    
    // First home buyer concession (simplified)
    if (isFirstHomeBuyer && propertyValue <= 550000) {
      stampDuty = 0;
    }
  }
  
  return {
    success: true,
    stampDuty: Math.round(stampDuty),
    state,
    propertyValue,
    isFirstHomeBuyer
  };
}
