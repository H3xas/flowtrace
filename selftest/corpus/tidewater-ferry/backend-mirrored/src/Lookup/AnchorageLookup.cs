using System.Threading.Tasks;

namespace Tidewater.Ferry.Mirror
{
    public interface IAnchorageLookup
    {
        Task<string> FindRouteAsync(string routeId);
        Task<string> FindFleetAsync(string routeId);
    }

    public class AnchorageLookup : IAnchorageLookup
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
