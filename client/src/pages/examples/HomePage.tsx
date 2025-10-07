import HomePage from "../HomePage";
import { ThemeProvider } from "@/hooks/use-theme";

export default function HomePageExample() {
  return (
    <ThemeProvider>
      <HomePage />
    </ThemeProvider>
  );
}
