using System.Threading.Tasks;
using DemoShop.Stock.DataAccess;
using DemoShop.Stock.Messaging.Events;

namespace DemoShop.Stock.Services
{
    public interface IReservationService
    {
        Task<bool> Reserve(string productId, int quantity);
    }

    public class ReservationService : IReservationService
    {
        private readonly IShelfRepository _shelves;
        private readonly IPublishEndpoint _bus;

        public ReservationService(IShelfRepository shelves, IPublishEndpoint bus)
        {
            _shelves = shelves;
            _bus = bus;
        }

        public async Task<bool> Reserve(string productId, int quantity)
        {
            var held = await _shelves.DecrementOnHand(productId, quantity);
            if (!held)
            {
                return false;
            }

            await _bus.Publish(new StockReservedEvent());
            return true;
        }
    }
}
