export type UserRole = "client" | "lawyer";

export interface Lawyer {
  id: string;
  name: string;
  specialty: string;
  rating: number;
  status: "available" | "busy" | "offline";
  lat?: number;
  lng?: number;
  price_per_minute: number;
  socket_id?: string;
  oab?: string;
}

export interface Emergency {
  id: string;
  user_id: string;
  lawyer_id?: string;
  status: "pending" | "accepted" | "in_progress" | "completed" | "cancelled";
  specialty: string;
  lat?: number;
  lng?: number;
  location?: { lat: number; lng: number };
  ai_summary?: string;
  created_at?: string;
  lawyerName?: string;
}

export interface Message {
  from: string;
  message: string;
  sender: string;
  timestamp: number;
}

export interface Rating {
  emergencyId: string;
  lawyerId: string;
  userId: string;
  score: number;
  comment?: string;
}

export interface LawyerStats {
  totalEmergencies: number;
  totalEarnings: number;
}
