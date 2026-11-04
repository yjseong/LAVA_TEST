import HomeClient from "@/components/home/HomeClient";
import SiteHeader from "@/components/SiteHeader";

export default function Page() {
  return (
    <>
      <SiteHeader />
      <main className="site-main">
        <HomeClient />
      </main>
    </>
  );
}
