import { useMemo } from "react";
import { RouterProvider } from "react-router/dom";
import { createRouter } from "./routes";

export function App() {
  const router = useMemo(() => createRouter(), []);
  return <RouterProvider router={router} />;
}
