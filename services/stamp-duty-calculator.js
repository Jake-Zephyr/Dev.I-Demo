// services/stamp-duty-calculator.js

export function calculateStampDuty(input) {
  const { propertyValue, state, useType, isFirstHomeBuyer, isNewHome, isVacantLand, isForeign } = input;
  
  // ... rest of the code I provided above
  
  let baseDuty = 0;
  let foreignSurcharge = 0;
  const concessionsApplied = [];
  const eligibilityNotes = [];
  const warnings = [];

  // ===== STATE CALCULATIONS =====
  
  if (state === 'QLD') {
    // QLD brackets
    if (propertyValue <= 5000) {
      baseDuty = 0;
    } else if (propertyValue <= 75000) {
      baseDuty = (propertyValue - 5000) * 0.015;
    } else if (propertyValue <= 540000) {
      baseDuty = 1050 + (propertyValue - 75000) * 0.035;
    } else if (propertyValue <= 1000000) {
      baseDuty = 17325 + (propertyValue - 540000) * 0.045;
    } else {
      baseDuty = 38025 + (propertyValue - 1000000) * 0.0575;
    }
    
    // QLD First Home Buyer (new homes only, from May 2025)
    if (isFirstHomeBuyer && isNewHome && useType === 'owner_occupied') {
      concessionsApplied.push({ code: 'QLD_FHB', amount: -baseDuty, label: 'First Home Buyer Exemption' });
      baseDuty = 0;
      eligibilityNotes.push('QLD first home buyer exemption applies to new homes with no price cap (from May 2025)');
    }
    
    // QLD Home Concession (owner-occupied, not vacant land)
    if (useType === 'owner_occupied' && !isVacantLand && !isFirstHomeBuyer) {
      const concessionValue = Math.min(propertyValue, 350000);
      let concessionAmount = 0;
      if (concessionValue <= 75000) {
        concessionAmount = (concessionValue - 5000) * 0.015;
      } else if (concessionValue <= 350000) {
        concessionAmount = 1050 + (concessionValue - 75000) * 0.035;
      }
      if (concessionAmount > 0) {
        concessionsApplied.push({ code: 'QLD_HOME', amount: -concessionAmount, label: 'Home Concession (first $350k)' });
        baseDuty = Math.max(0, baseDuty - concessionAmount);
      }
    }
    
    // QLD Foreign surcharge (7%)
    if (isForeign) {
      foreignSurcharge = propertyValue * 0.07;
    }
  }
  
  else if (state === 'NSW') {
    // NSW brackets
    if (propertyValue <= 16000) {
      baseDuty = propertyValue * 0.0125;
    } else if (propertyValue <= 35000) {
      baseDuty = 200 + (propertyValue - 16000) * 0.015;
    } else if (propertyValue <= 93000) {
      baseDuty = 485 + (propertyValue - 35000) * 0.0175;
    } else if (propertyValue <= 351000) {
      baseDuty = 1500 + (propertyValue - 93000) * 0.035;
    } else if (propertyValue <= 1168000) {
      baseDuty = 10530 + (propertyValue - 351000) * 0.045;
    } else if (propertyValue <= 3505000) {
      baseDuty = 47295 + (propertyValue - 1168000) * 0.055;
    } else {
      baseDuty = 175630 + (propertyValue - 3505000) * 0.07;
    }
    
    // NSW First Home Buyer
    if (isFirstHomeBuyer && useType === 'owner_occupied') {
      if (propertyValue <= 800000) {
        concessionsApplied.push({ code: 'NSW_FHB', amount: -baseDuty, label: 'First Home Buyer Exemption' });
        baseDuty = 0;
      } else if (propertyValue <= 1000000) {
        const reduction = baseDuty * ((1000000 - propertyValue) / 200000);
        concessionsApplied.push({ code: 'NSW_FHB_PARTIAL', amount: -reduction, label: 'First Home Buyer Concession' });
        baseDuty = baseDuty - reduction;
      }
    }
    
    // NSW Foreign surcharge (8%)
    if (isForeign) {
      foreignSurcharge = propertyValue * 0.08;
    }
  }
  
  else if (state === 'VIC') {
    // VIC brackets
    if (propertyValue <= 25000) {
      baseDuty = propertyValue * 0.014;
    } else if (propertyValue <= 130000) {
      baseDuty = 350 + (propertyValue - 25000) * 0.024;
    } else if (propertyValue <= 960000) {
      baseDuty = 2870 + (propertyValue - 130000) * 0.06;
    } else if (propertyValue <= 2000000) {
      baseDuty = 52670 + (propertyValue - 960000) * 0.055;
    } else {
      baseDuty = 110000 + (propertyValue - 2000000) * 0.065;
    }
    
    // VIC First Home Buyer
    if (isFirstHomeBuyer && useType === 'owner_occupied' && propertyValue <= 600000) {
      concessionsApplied.push({ code: 'VIC_FHB', amount: -baseDuty, label: 'First Home Buyer Exemption' });
      baseDuty = 0;
    }
    
    // VIC Foreign surcharge (8%)
    if (isForeign) {
      foreignSurcharge = propertyValue * 0.08;
    }
  }
  
  else if (state === 'WA') {
    // WA brackets
    if (propertyValue <= 120000) {
      baseDuty = propertyValue * 0.019;
    } else if (propertyValue <= 150000) {
      baseDuty = 2280 + (propertyValue - 120000) * 0.0285;
    } else if (propertyValue <= 360000) {
      baseDuty = 3135 + (propertyValue - 150000) * 0.038;
    } else if (propertyValue <= 725000) {
      baseDuty = 11115 + (propertyValue - 360000) * 0.0475;
    } else {
      baseDuty = 28453 + (propertyValue - 725000) * 0.0515;
    }
    
    // WA First Home Buyer
    if (isFirstHomeBuyer && useType === 'owner_occupied' && propertyValue <= 530000) {
      concessionsApplied.push({ code: 'WA_FHB', amount: -baseDuty, label: 'First Home Buyer Exemption' });
      baseDuty = 0;
    }
    
    // WA Foreign surcharge (7%)
    if (isForeign) {
      foreignSurcharge = propertyValue * 0.07;
    }
  }
  
  else if (state === 'SA') {
    // SA brackets
    if (propertyValue <= 12000) {
      baseDuty = propertyValue * 0.01;
    } else if (propertyValue <= 30000) {
      baseDuty = 120 + (propertyValue - 12000) * 0.02;
    } else if (propertyValue <= 50000) {
      baseDuty = 480 + (propertyValue - 30000) * 0.03;
    } else if (propertyValue <= 100000) {
      baseDuty = 1080 + (propertyValue - 50000) * 0.035;
    } else if (propertyValue <= 200000) {
      baseDuty = 2830 + (propertyValue - 100000) * 0.04;
    } else if (propertyValue <= 250000) {
      baseDuty = 6830 + (propertyValue - 200000) * 0.045;
    } else if (propertyValue <= 300000) {
      baseDuty = 9080 + (propertyValue - 250000) * 0.05;
    } else if (propertyValue <= 500000) {
      baseDuty = 11580 + (propertyValue - 300000) * 0.055;
    } else {
      baseDuty = 22580 + (propertyValue - 500000) * 0.055;
    }
    
    // SA Foreign surcharge (7%)
    if (isForeign) {
      foreignSurcharge = propertyValue * 0.07;
    }
  }
  
  else if (state === 'TAS') {
    // TAS brackets
    if (propertyValue <= 3000) {
      baseDuty = 50;
    } else if (propertyValue <= 25000) {
      baseDuty = 50 + (propertyValue - 3000) * 0.0175;
    } else if (propertyValue <= 75000) {
      baseDuty = 435 + (propertyValue - 25000) * 0.0225;
    } else if (propertyValue <= 200000) {
      baseDuty = 1560 + (propertyValue - 75000) * 0.035;
    } else if (propertyValue <= 375000) {
      baseDuty = 5935 + (propertyValue - 200000) * 0.04;
    } else if (propertyValue <= 725000) {
      baseDuty = 12935 + (propertyValue - 375000) * 0.0425;
    } else {
      baseDuty = 27810 + (propertyValue - 725000) * 0.045;
    }
    
    // TAS First Home Buyer
    if (isFirstHomeBuyer && useType === 'owner_occupied' && propertyValue <= 600000) {
      baseDuty = baseDuty * 0.5; // 50% discount
      concessionsApplied.push({ code: 'TAS_FHB', amount: -(baseDuty), label: 'First Home Buyer 50% Discount' });
    }
  }
  
  else if (state === 'ACT') {
    // ACT brackets (simplified)
    if (propertyValue <= 200000) {
      baseDuty = propertyValue * 0.006 + 20;
    } else if (propertyValue <= 300000) {
      baseDuty = 1220 + (propertyValue - 200000) * 0.0227;
    } else if (propertyValue <= 500000) {
      baseDuty = 3490 + (propertyValue - 300000) * 0.0349;
    } else if (propertyValue <= 750000) {
      baseDuty = 10470 + (propertyValue - 500000) * 0.0415;
    } else if (propertyValue <= 1000000) {
      baseDuty = 20845 + (propertyValue - 750000) * 0.0500;
    } else if (propertyValue <= 1455000) {
      baseDuty = 33345 + (propertyValue - 1000000) * 0.055;
    } else {
      baseDuty = 58370 + (propertyValue - 1455000) * 0.056;
    }
    
    // ACT First Home Buyer
    if (isFirstHomeBuyer && useType === 'owner_occupied' && propertyValue <= 1000000) {
      concessionsApplied.push({ code: 'ACT_FHB', amount: -baseDuty, label: 'First Home Buyer Exemption' });
      baseDuty = 0;
    }
  }
  
  else if (state === 'NT') {
    // NT brackets
    if (propertyValue <= 525000) {
      baseDuty = propertyValue * 0.000049 * (1.8 * Math.pow(propertyValue, 0.27));
    } else {
      baseDuty = propertyValue * 0.0495;
    }
    
    // NT has different concession structure - simplified
    if (isFirstHomeBuyer && useType === 'owner_occupied' && propertyValue <= 650000) {
      const discount = Math.min(baseDuty, 18601);
      concessionsApplied.push({ code: 'NT_FHB', amount: -discount, label: 'First Home Buyer Discount' });
      baseDuty = Math.max(0, baseDuty - discount);
    }
  }

  // ===== FINAL CALCULATION =====
  const totalDuty = Math.round(baseDuty + foreignSurcharge);

  return {
    success: true,
    stampDuty: totalDuty,
    breakdown: {
      baseDuty: Math.round(baseDuty),
      foreignSurcharge: Math.round(foreignSurcharge),
      concessionsApplied
    },
    eligibilityNotes,
    warnings,
    disclaimer: 'This is an estimate only. Confirm with the relevant state revenue office before making financial decisions.'
  };
}
