using System.Threading.Tasks;
using Tidewater.Ferry.Models;

namespace Tidewater.Ferry.Mirror
{
    public interface IZephyrAccess
    {
        Task<PassengerIdentity> ResolveIdentityAsync(PassengerRequest request);
        Task LoadPermitsAsync(PassengerRequest request);
    }

    public class ZephyrAccess : IZephyrAccess
    {
        public Task<PassengerIdentity> ResolveIdentityAsync(PassengerRequest request)
        {
            return Task.FromResult(new PassengerIdentity { PassengerId = request.PassengerId });
        }

        public Task LoadPermitsAsync(PassengerRequest request)
        {
            return Task.CompletedTask;
        }
    }
}
