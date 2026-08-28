import { RequestStatus } from '../../../components/request-status';

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestStatus requestId={id} />;
}
