// Test script for chat title generation endpoint
// Tests the logic without needing a running server

function generateChatTitle(firstMessage) {
  const message = firstMessage.toLowerCase();

  // Pattern matching for property identifiers
  const addressMatch = firstMessage.match(/(\d+\s+[\w\s]+(?:street|st|avenue|ave|road|rd|drive|dr|parade|pde|court|ct|crescent|cres|place|pl|terrace|tce|boulevard|bvd|highway|hwy|lane|ln|way|walk))/i);
  const lotplanMatch = firstMessage.match(/\b(\d+[A-Z]{2,4}\d+)\b/i);
  const suburbMatch = firstMessage.match(/\b(mermaid|broadbeach|surfers|southport|burleigh|palm beach|robina|varsity|currumbin|coolangatta|labrador|runaway bay|hope island|coomera|ormeau|oxenford|helensvale|miami|nobby beach|main beach|clear island|ashmore|benowa|bundall|chevron island|elanora|merrimac|molendinar|mudgeeraba|nerang|paradise point|parkwood|reedy creek|tallebudgera|worongary|carrara|biggera waters|coombabah|gilston|gaven|highland park|hollywell|jacobs well|maudsland|monterey keys|pacific pines|pimpama|stapylton|upper coomera|willow vale|wongawallan|arundel|bonogin|natural bridge|advancetown|cedar creek)\b/i);

  // Intent keywords (ordered by specificity - most specific first)
  const intentPatterns = {
    'Development Applications': /development application|DA|planning approval|permit|approval|consent/i,
    'Stamp Duty': /stamp duty|tax|transfer duty|duty/i,
    'Height': /height|storeys|stories|floors|tall|how tall|building height/i,
    'Overlays': /overlay|overlays|restriction|constraint|heritage|environmental|flood/i,
    'Density': /density|RD\d|how many|units|dwellings|bedrooms/i,
    'Feasibility': /feasibility|feaso|numbers|viable|profit|cost|roi|return/i,
    'Zoning': /zone|zoning|what can i build|can i build|planning rules|land use|permitted/i,
    'Property Info': /information|info|details|data|tell me about/i
  };

  // Find matching intent
  let intent = null;
  for (const [key, pattern] of Object.entries(intentPatterns)) {
    if (pattern.test(message)) {
      intent = key;
      break;
    }
  }

  // Generate title based on priority
  let title = '';

  // Priority 1: Address + Intent
  if (addressMatch && intent) {
    const address = addressMatch[1];
    // Shorten address if too long (keep number + first word of street)
    const shortAddress = address.match(/(\d+\s+\w+)/)?.[1] || address.substring(0, 20);
    title = `${shortAddress} ${intent}`;
  }
  // Priority 2: Lot/Plan + Intent
  else if (lotplanMatch && intent) {
    title = `${lotplanMatch[1]} ${intent}`;
  }
  // Priority 3: Suburb + Intent
  else if (suburbMatch && intent) {
    const suburb = suburbMatch[1].charAt(0).toUpperCase() + suburbMatch[1].slice(1).toLowerCase();
    title = `${suburb} ${intent}`;
  }
  // Priority 4: Intent only
  else if (intent) {
    title = `${intent} Query`;
  }
  // Fallback: First 40 characters of message
  else {
    title = firstMessage.substring(0, 40);
    if (firstMessage.length > 40) {
      title += '...';
    }
    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }

  return title;
}

// Test cases
const testCases = [
  {
    input: "What can I build on 22 Mary Avenue Broadbeach",
    expected: "22 Mary Zoning"
  },
  {
    input: "Run a feaso on 295RP21863",
    expected: "295RP21863 Feasibility"
  },
  {
    input: "What can I build on 12RP39932?",
    expected: "12RP39932 Zoning"
  },
  {
    input: "Tell me about overlays in Broadbeach",
    expected: "Broadbeach Overlays"
  },
  {
    input: "What's the density for 15 Ocean Street?",
    expected: "15 Ocean Density"
  },
  {
    input: "Hi",
    expected: "Hi"
  },
  {
    input: "What are development applications near Surfers Paradise?",
    expected: "Surfers Development Applications"
  },
  {
    input: "Calculate stamp duty for a $500k property",
    expected: "Stamp Duty Query"
  },
  {
    input: "How tall can I build on 100 Gold Coast Highway Mermaid Beach?",
    expected: "100 Gold Height"
  }
];

console.log('🧪 Testing Chat Title Generation\n');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  const result = generateChatTitle(test.input);
  const isPass = result === test.expected;

  if (isPass) {
    passed++;
    console.log(`✅ Test ${index + 1}: PASSED`);
  } else {
    failed++;
    console.log(`❌ Test ${index + 1}: FAILED`);
  }

  console.log(`   Input:    "${test.input}"`);
  console.log(`   Expected: "${test.expected}"`);
  console.log(`   Got:      "${result}"`);
  console.log('');
});

console.log('='.repeat(60));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${testCases.length} tests`);

if (failed === 0) {
  console.log('🎉 All tests passed!');
  process.exit(0);
} else {
  console.log('⚠️  Some tests failed');
  process.exit(1);
}
