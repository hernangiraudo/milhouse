"use client";

import { DesignEditor } from "@/components/DesignEditor";

export default function NewProjectPage() {
  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <DesignEditor currentName={null} />
    </main>
  );
}
