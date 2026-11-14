using System.Threading.Tasks;

namespace Tidewater.Ferry.Lookup
{
    public interface IRouteLookup
    {
        Task<string> FindRouteAsync(string routeId);
        Task<string> FindFleetAsync(string routeId);
    }

    public class RouteLookup : IRouteLookup
    {
        public Task<string> FindRouteAsync(string routeId)
        {
            return Task.FromResult(routeId);
        }

        public Task<string> FindFleetAsync(string routeId)
        {
            return Task.FromResult(routeId);
        }
    }
}
