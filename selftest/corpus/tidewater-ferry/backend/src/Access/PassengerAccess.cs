using System.Threading.Tasks;
using Tidewater.Ferry.Models;

namespace Tidewater.Ferry.Access
{
    public interface IPassengerAccess
    {
        Task<PassengerIdentity> ResolveIdentityAsync(PassengerRequest request);
        Task LoadPermitsAsync(PassengerRequest request);
        Task<PassengerIdentity> ReadIdentityAsync(PassengerRequest request);
    }

    public class PassengerAccess : IPassengerAccess
    {
        public Task<PassengerIdentity> ResolveIdentityAsync(PassengerRequest request)
        {
            return Task.FromResult(new PassengerIdentity { PassengerId = request.PassengerId });
        }

        public Task LoadPermitsAsync(PassengerRequest request)
        {
            return Task.CompletedTask;
        }

        public Task<PassengerIdentity> ReadIdentityAsync(PassengerRequest request)
        {
            return Task.FromResult(new PassengerIdentity { PassengerId = request.PassengerId });
        }
    }
}
