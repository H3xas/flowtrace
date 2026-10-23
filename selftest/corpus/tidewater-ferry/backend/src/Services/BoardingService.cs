using System.Threading.Tasks;
using Tidewater.Ferry.Access;
using Tidewater.Ferry.Lookup;
using Tidewater.Ferry.Models;

namespace Tidewater.Ferry.Services
{
    public class BoardingService
    {
        private readonly IPassengerAccess _access;
        private readonly IRouteLookup _lookup;

        public BoardingService(IPassengerAccess access, IRouteLookup lookup)
        {
            _access = access;
            _lookup = lookup;
        }

        public async Task<BoardingResult> CheckInAsync(PassengerRequest request)
        {
            if (request.PassengerId == null)
            {
                await _access.ResolveIdentityAsync(request);
            }

            await _lookup.FindRouteAsync(request.RouteId);
            await _lookup.FindFleetAsync(request.RouteId);

            if (request.LoadPermits)
            {
                await _access.LoadPermitsAsync(request);
            }

            return new BoardingResult { Accepted = true };
        }

        public async Task RepeatForm(PassengerRequest request)
        {
            await _access.ResolveIdentityAsync(request); await _access.ResolveIdentityAsync(request);
            await _access.ReadIdentityAsync(request);
        }

        public async Task RecursiveForm(PassengerRequest request, int depth)
        {
            if (depth > 0)
            {
                await RecursiveForm(request, depth - 1);
            }

            await _access.ReadIdentityAsync(request);
        }

        public async Task MutualFirst(PassengerRequest request)
        {
            await MutualSecond(request);
        }

        public async Task MutualSecond(PassengerRequest request)
        {
            await MutualFirst(request);
        }
    }
}
