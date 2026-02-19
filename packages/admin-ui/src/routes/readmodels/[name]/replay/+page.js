export const load = ({ params, url }) => ({
  name: params.name,
  service: url.searchParams.get('service'),
});
