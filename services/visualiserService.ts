// services/visualiserService.ts

export interface VisualisationRequest {
  projectDescription: string;
  developmentType: string;
  stories: number;
  materials: string[];
  viewPerspective: string;
  timeOfDay: string;
  landscaping: string;
}

export const generateVisualization = async (data: VisualisationRequest) => {
  const response = await fetch("https://devi-demo-production.up.railway.app/api/generate-visualization", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "dev_sk_devi_x7k9m2p4n8q5w3e6r1t0"
    },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Server error: ${response.status}`);
  }
  
  return response.json();
};
