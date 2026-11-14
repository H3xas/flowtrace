using System.Threading.Tasks;
using Tidewater.Ferry.Models;

namespace Tidewater.Ferry.Mirror
{
    public class GateService
    {
        private readonly IAnchorageLookup _courses;
        private readonly IZephyrAccess _gateways;

        public GateService(IAnchorageLookup courses, IZephyrAccess gateways)
        {
            _courses = courses;
            _gateways = gateways;
        }

        public async Task<int> CheckInAsync(PassengerRequest request)
        {
            if (request.PassengerId == null)
            {
                await _gateways.ResolveIdentityAsync(request);
            }

            await _courses.FindRouteAsync(request.RouteId);
            await _courses.FindFleetAsync(request.RouteId);

            if (request.LoadPermits)
            {
                await _gateways.LoadPermitsAsync(request);
            }

            return 0;
        }
    }
}
