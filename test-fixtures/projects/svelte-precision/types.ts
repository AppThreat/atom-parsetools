export interface CounterProps {
  initial?: number;
  label?: string;
}

export interface Row {
  id: string;
  name: string;
  score: number;
}

export interface Item {
  id: string;
  title: string;
}

export interface PanelState {
  id: string;
  open: boolean;
}

export interface Person {
  first: string;
  last: string;
  email: string;
}

export interface Profile {
  name: string;
  email: string;
}

export interface Note {
  body: string | null;
}
