"use client";

import { useParams } from "next/navigation";
import { DesignEditor } from "@/components/DesignEditor";

export default function EditProjectPage() {
  const params = useParams<{ name: string }>();
  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <DesignEditor currentName={decodeURIComponent(params.name)} />
    </main>
  );
}
